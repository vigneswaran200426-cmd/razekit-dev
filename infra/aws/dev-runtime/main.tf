# RazeKit DEV build runtime: one Fargate task per build invocation.
#
# Isolation, by construction:
#   * Tasks run in private subnets with NO internet route (no IGW, no NAT).
#     The only ways out are VPC endpoints: S3 (gateway, restricted by policy to
#     the run bucket), ECR and CloudWatch Logs (interface, for image pull and
#     logs). A build cannot reach the internet or any other AWS account.
#   * The task role has NO permissions. Builds receive two pre-signed URLs for
#     their own objects and nothing else.
#   * The container runs as an unprivileged user, read-only root filesystem,
#     all Linux capabilities dropped, a single writable /work volume.
#   * Run objects expire after one day even if the worker never deletes them.

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.availability_zones)
}

# ── Network ──────────────────────────────────────────────────────────────────

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${var.name}-vpc" }
}

resource "aws_subnet" "private" {
  count             = length(local.azs)
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index)
  tags              = { Name = "${var.name}-private-${local.azs[count.index]}" }
}

# A route table with no default route: nothing leaves except via endpoints.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-private" }
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_security_group" "runner" {
  name        = "${var.name}-runner"
  description = "RazeKit DEV build tasks: no inbound; HTTPS out to VPC endpoints and S3 only"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_egress_rule" "runner_to_endpoints" {
  security_group_id            = aws_security_group.runner.id
  referenced_security_group_id = aws_security_group.endpoints.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "runner_to_s3" {
  security_group_id = aws_security_group.runner.id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_security_group" "endpoints" {
  name        = "${var.name}-endpoints"
  description = "Interface endpoints, reachable from build tasks only"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_runner" {
  security_group_id            = aws_security_group.endpoints.id
  referenced_security_group_id = aws_security_group.runner.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.name}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  # Only the run bucket, and the ECR layer bucket image pulls need.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "RunBucketOnly"
        Effect    = "Allow"
        Principal = "*"
        Action    = ["s3:GetObject", "s3:PutObject"]
        Resource  = ["${aws_s3_bucket.runs.arn}/*"]
      },
      {
        Sid       = "EcrLayers"
        Effect    = "Allow"
        Principal = "*"
        Action    = ["s3:GetObject"]
        Resource  = ["arn:aws:s3:::prod-${data.aws_region.current.name}-starport-layer-bucket/*"]
      },
    ]
  })
  tags = { Name = "${var.name}-s3" }
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(["ecr.api", "ecr.dkr", "logs"])
  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${data.aws_region.current.name}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = { Name = "${var.name}-${each.key}" }
}

# ── Storage: the run bucket ──────────────────────────────────────────────────

resource "aws_s3_bucket" "runs" {
  bucket_prefix = "${var.name}-runs-"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "runs" {
  bucket                  = aws_s3_bucket.runs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "runs" {
  bucket = aws_s3_bucket.runs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "runs" {
  bucket = aws_s3_bucket.runs.id
  rule {
    id     = "expire-runs"
    status = "Enabled"
    filter {}
    expiration {
      days = 1
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_policy" "runs" {
  bucket = aws_s3_bucket.runs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TlsOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.runs.arn, "${aws_s3_bucket.runs.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# ── Image registry ───────────────────────────────────────────────────────────

resource "aws_ecr_repository" "runner" {
  name                 = "${var.name}-runner"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "runner" {
  repository = aws_ecr_repository.runner.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 10 runner images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 10 }
      action       = { type = "expire" }
    }]
  })
}

# ── Compute ──────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "runner" {
  name              = "/${var.name}/runner"
  retention_in_days = 14
}

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

# Used by ECS itself to pull the image and write logs. Never by build code.
resource "aws_iam_role" "execution" {
  name               = "${var.name}-runner-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The identity build code runs as: deliberately without a single permission.
resource "aws_iam_role" "task" {
  name               = "${var.name}-runner-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_ecs_task_definition" "runner" {
  family                   = "${var.name}-runner"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  ephemeral_storage {
    size_in_gib = 21
  }
  volume {
    name = "work"
  }
  # The empty lists (portMappings, volumesFrom, systemControls, capabilities.add)
  # are what ECS stores. Declaring them keeps every plan from replacing this
  # task definition with an identical one.
  container_definitions = jsonencode([{
    name                   = "runner"
    image                  = var.runner_image
    essential              = true
    user                   = "1000:1000"
    readonlyRootFilesystem = true
    environment            = [{ name = "WORK_DIR", value = "/work" }]
    mountPoints            = [{ sourceVolume = "work", containerPath = "/work", readOnly = false }]
    portMappings           = []
    volumesFrom            = []
    systemControls         = []
    linuxParameters = {
      initProcessEnabled = true
      capabilities       = { add = [], drop = ["ALL"] }
    }
    stopTimeout = 5
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.runner.name
        awslogs-region        = data.aws_region.current.name
        awslogs-stream-prefix = "run"
      }
    }
  }])
}

# ── What the DEV worker may do: start, watch and stop runner tasks, and
#    read/write run objects. Nothing else. ─────────────────────────────────────

data "aws_iam_policy_document" "worker" {
  statement {
    sid       = "RunRunnerTasks"
    actions   = ["ecs:RunTask"]
    resources = ["arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:task-definition/${aws_ecs_task_definition.runner.family}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }
  statement {
    sid       = "TagRunnerTasks"
    actions   = ["ecs:TagResource"]
    resources = ["arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:task/${aws_ecs_cluster.this.name}/*"]
    condition {
      test     = "StringEquals"
      variable = "ecs:CreateAction"
      values   = ["RunTask"]
    }
  }
  statement {
    sid       = "WatchAndStopRunnerTasks"
    actions   = ["ecs:DescribeTasks", "ecs:StopTask"]
    resources = ["arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:task/${aws_ecs_cluster.this.name}/*"]
  }
  statement {
    sid       = "PassRunnerRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  statement {
    sid       = "RunObjects"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.runs.arn}/runs/*"]
  }
}

resource "aws_iam_policy" "worker" {
  name        = "${var.name}-worker"
  description = "The RazeKit DEV worker: start, watch and stop build runner tasks; run objects only."
  policy      = data.aws_iam_policy_document.worker.json
}

resource "aws_iam_role_policy_attachment" "worker" {
  count      = var.worker_role_name == "" ? 0 : 1
  role       = var.worker_role_name
  policy_arn = aws_iam_policy.worker.arn
}
