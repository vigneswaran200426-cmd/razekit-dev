output "ecr_repository_url" {
  description = "Push the runner image here, then set runner_image to it by digest."
  value       = aws_ecr_repository.runner.repository_url
}

output "worker_policy_arn" {
  description = "Attach to the identity the DEV worker runs as."
  value       = aws_iam_policy.worker.arn
}

output "worker_environment" {
  description = "The DEV worker's environment for this runtime."
  value = {
    DEV_RUNTIME             = "fargate"
    DEV_AWS_REGION          = data.aws_region.current.name
    DEV_AWS_CLUSTER         = aws_ecs_cluster.this.name
    DEV_AWS_TASK_DEFINITION = aws_ecs_task_definition.runner.arn
    DEV_AWS_CONTAINER       = "runner"
    DEV_AWS_SUBNETS         = join(",", aws_subnet.private[*].id)
    DEV_AWS_SECURITY_GROUPS = aws_security_group.runner.id
    DEV_AWS_BUCKET          = aws_s3_bucket.runs.bucket
    DEV_AWS_PREFIX          = "runs"
  }
}
