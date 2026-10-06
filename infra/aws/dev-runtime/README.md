# RazeKit DEV build runtime on AWS

One AWS Fargate task per build invocation (`DEV_RUNTIME=fargate`). Build code
never runs on the DEV worker; see `server/src/development/runtime/aws/`.

**Status:** applied on 2026-09-26 to account `074189217970`, `us-east-2`
(Terraform 1.16.4, AWS provider 5.100.0), and `terraform plan` reports no
changes. The runner image is
`razekit-dev-runner@sha256:fd3b996e803c8f0730b4ae09e22d51212d923e570c63afcce0f670518083816c`
(tag `dev-ee5802e`). A smoke test ran one real Fargate task through pre-signed
URLs: it exited 0 in 43 s, wrote to `/work` as UID 1000, was denied reading
outside `/work` (`ERR_ACCESS_DENIED`), could not reach the internet
(`ETIMEDOUT`), and its logs reached CloudWatch. ECR's scan of that image
reports 3 critical and 12 high CVEs, all in the Debian base (`perl`,
`util-linux`, `zlib`), none in the runner.

## What it creates

| Resource | Why |
|---|---|
| VPC, private subnets, a route table with **no default route** | builds have no internet |
| S3 gateway endpoint (policy: the run bucket + ECR layers only) | the only data path out |
| ECR API/DKR + Logs interface endpoints | image pull and logs without internet |
| Security groups: runner has no inbound, HTTPS out to endpoints/S3 only | |
| S3 run bucket: private, encrypted, TLS-only, objects expire after 1 day | run inputs/outputs |
| ECR repository: immutable tags, scan on push | the runner image |
| ECS cluster + task definition: non-root, read-only root fs, all capabilities dropped, one `/work` volume | the sandbox |
| Execution role (ECS pulls image, writes logs); task role with **no permissions** | build code gets no AWS identity |
| Worker policy: RunTask on this task definition in this cluster, Describe/Stop its tasks, PassRole to ECS only, run objects only | least privilege for the DEV worker |

Cost at rest: the three interface endpoints (~$0.01/hour each per AZ, so
~$22/month with the default one AZ). Each build invocation is one Fargate task
(1 vCPU, 2 GB) for about a minute.

## State

State lives in S3 (`backend.tf`): bucket `razekit-dev-tfstate-074189217970`,
key `dev-runtime/terraform.tfstate`, versioned, encrypted, public access
blocked, TLS-only, with S3-native locking (`use_lockfile`, Terraform >= 1.10).
The bucket was created outside Terraform, once, by an operator; the latest
`terraform output -json` is kept beside the state as `dev-runtime/outputs.json`.

## Apply

```sh
cd infra/aws/dev-runtime
terraform init   # uses the S3 backend
# 1. Create the repository first, build and push the runner image.
terraform apply -target=aws_ecr_repository.runner -var runner_image=placeholder
cd ../../..   # the image builds from the repository root
docker buildx build --platform linux/amd64 -f infra/aws/dev-runtime/runner.Dockerfile \
  -t <ecr_repository_url>:<git-sha> --push .
# note the pushed digest (tags are immutable; the task definition takes the digest)
cd infra/aws/dev-runtime
# 2. Everything else, with the image by digest.
terraform apply -var runner_image=<ecr_repository_url>@sha256:<digest> [-var worker_role_name=<role>]
terraform output worker_environment   # set these on the DEV worker
```

The DEV worker needs AWS credentials for `worker_policy_arn` from the standard
provider chain. On AWS, run it with an IAM role. Off AWS (e.g. Render), use
an IAM user limited to that policy, with its keys in the worker's environment.

## Deployer identity

Terraform runs as the `razekit-dev-deployer` IAM user, never as an
administrator. Its policy is `deployer-policy.json`: replace `ACCOUNT_ID` and
create it as the customer managed policy `razekit-dev-deployer`. It reaches
only this configuration's resources in `us-east-2`: the `razekit-dev` names,
networking tagged `Product=RazeKitDEV`, and runner roles that can have only the
ECS task execution policy attached and be passed only to ECS tasks. So keep
`name` and `region` at their defaults. It also reads and writes the Terraform
state (`TerraformState*` statements). It does not cover creating the Render
worker's IAM user; an operator does that.

The first apply (2026-09-26) ran from AWS CloudShell as the account's root
user, not as the deployer, because no deployer key was available. So the
deployer policy has still not been exercised against the live account: the
first plan or apply run as the deployer may hit an AccessDenied, which names
the one action to add.
