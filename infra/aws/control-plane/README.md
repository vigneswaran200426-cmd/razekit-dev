# RazeKit DEV 24/7 control plane and GPU inference (AWS, us-east-2)

**Status: designed and scripted, NOT applied.** Nothing in this directory has
been created in AWS. The account inspection that decided the plan is below;
the launch is waiting on decisions only the account owner can make.

## What runs where

| Process | Where | Unix user | What it may touch |
|---|---|---|---|
| System A — Builder (`src/ops-supervisor.js --system=builder`) | control-plane EC2 | `razekit-builder` | its workspace, Docker, GitHub (one fine-grained token for this repo) |
| System B — Auditor (`src/ops-supervisor.js --system=auditor`) | control-plane EC2 | `razekit-auditor` | read-only HTTP to the DEV runtime, the database; no GitHub, no AWS |
| Inference gateway (`src/inference-gateway.js`) | control-plane EC2 | `razekit-gateway` | Ollama on the GPU instance (private IP), the GPU instance start/stop, the budget |
| Ollama with `qwen3-coder:30b` and `gpt-oss:20b` | GPU EC2, started on demand | `ollama` | its encrypted model volume |
| DEV web service + admin page (`/admin/24-7`) + Niomi/Konami coordinator | Render (`razekit-dev`) | — | unchanged |

All of them share state through the existing Neon DEV database (schema
`razekit_dev`, additive collections `ops*`). The web service on Render never
talks to the control plane directly: an admin action is a row in the
database, the owning process accepts it, and the page shows what the process
reported.

Only the gateway can reach instance metadata, so only it holds the instance
role's credentials. Builder and auditor are blocked from `169.254.169.254` by
UID; containers are blocked from metadata and from every private network.
No port on either instance is open to the internet: the control plane has no
inbound rules at all; the GPU instance admits TCP 11434 from the control
plane's security group only. No browser-debugging port exists (Playwright
drives Chromium over a pipe).

## Account facts (read 2026-10-09 through the existing console session, CloudShell)

| Fact | Value |
|---|---|
| Account / region | `074189217970` / `us-east-2` (verified with `sts get-caller-identity`) |
| Account plan | **AWS Free plan**, active, **$81.77 credits remaining**, plan expires 2027-03-18 |
| EC2 instances, EBS volumes, Elastic IPs | none |
| EBS encryption by default | **off** (this plan enables it before creating volumes) |
| G and VT on-demand vCPU quota (`L-DB2E81BA`) | **0** |
| G and VT spot vCPU quota (`L-3819A6DF`) | **0** |
| Standard on-demand vCPU quota | 32 |
| GPU types offered in us-east-2 | g4dn.xlarge, g5.xlarge (A10G 24 GB), g6.xlarge (L4 24 GB), g6e.xlarge (L40S 48 GB) |
| AWS Budgets | none configured |
| Cost Explorer | not enabled for this account |
| Existing RazeKit resources | ECS cluster `razekit-dev`, ECR `razekit-dev-runner`, S3 run bucket + tfstate bucket, SGs `razekit-dev-runner`/`-endpoints`, three interface VPC endpoints (from `infra/aws/dev-runtime`) |
| IAM | users `razekit-dev-automation`, `razekit-dev-deployer`; roles for the Fargate runner |

## Blockers (in order)

1. **GPU quota is 0.** A g6.xlarge or g5.xlarge needs 4 vCPU of
   "Running On-Demand G and VT instances". Requesting it is free, but it is an
   account request reviewed by AWS, and on the Free plan it is commonly
   declined until the account is upgraded to a paid plan.
2. **Free plan.** Upgrading to a paid plan is the owner's decision: credits
   continue to apply, but charges beyond them are billed to the card.
3. **ADMIN_EMAIL** is not configured anywhere in this repository; it is needed
   for the budget alert and for System B's alerts. It is not guessed.
4. **No GitHub token for System A.** Without `RAZEKIT_BUILDER_GITHUB_TOKEN`,
   System A commits in its workspace but cannot push or open draft PRs.

## Estimated recurring cost (on-demand list prices, us-east-2 — verify on the EC2 pricing page before relying on them)

| Item | Estimate |
|---|---|
| Control plane `t3.small` (2 vCPU, 2 GiB), 24/7 | ≈ $15/month |
| Its 30 GB gp3 root volume | ≈ $2.40/month |
| Its public IPv4 address (needed for outbound without a NAT gateway) | ≈ $3.65/month |
| GPU `g6.xlarge` (L4 24 GB) **only while running** | ≈ $0.80/hour |
| GPU 150 GB encrypted gp3 model + OS volume (billed even when stopped) | ≈ $12/month |
| Already running: three interface VPC endpoints from `dev-runtime` | ≈ $22/month (per that README) |

At these rates the existing credits cover roughly two months of the CPU side
plus the endpoints, before any GPU hours. The two models need about
19 GB (`qwen3-coder:30b`, Q4_K_M) and 14 GB (`gpt-oss:20b`) of disk; they
cannot both be resident on a 24 GB GPU, so the gateway loads one at a time
(`OLLAMA_MAX_LOADED_MODELS=1`, explicit eviction before each switch).

## Spending safeguards (applied before any GPU exists)

- **AWS Budget** `razekit-dev-monthly` (`iam/budget.json`) with email alerts at
  50/80/100 % actual and 100 % forecast.
- **Gateway hard limit:** it refuses to start the GPU unless
  `RAZEKIT_GPU_HOURLY_USD` and `RAZEKIT_GPU_MONTHLY_BUDGET_USD` are set, stops a
  running GPU once the measured month-to-date estimate reaches the budget, and
  stops it after `RAZEKIT_GPU_IDLE_STOP_MINUTES` without inference.
- `RAZEKIT_GPU_AUTO_START=false` by default: the GPU starts only when an admin
  presses Start GPU (or after the owner turns auto-start on).
- Per-system daily token budgets in the gateway.
- The instance role can start/stop only instances tagged
  `razekit:role=gpu-inference` (`iam/control-plane-role-policy.json`).

## Apply (from AWS CloudShell in the owner's console session)

```sh
# 0. Protective, free: EBS encryption by default; the budget with alerts.
aws ec2 enable-ebs-encryption-by-default --region us-east-2
sed "s/BUDGET_USD/40/" iam/budget.json > /tmp/budget.json
aws budgets create-budget --account-id 074189217970 --budget file:///tmp/budget.json \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":50,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"ADMIN_EMAIL"}]},{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"ADMIN_EMAIL"}]},{"Notification":{"NotificationType":"FORECASTED","ComparisonOperator":"GREATER_THAN","Threshold":100,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"ADMIN_EMAIL"}]}]'

# 1. Role + instance profile for the control plane (policy above, account id substituted).
# 2. Security group razekit-dev-control-plane: no inbound; egress 443, 5432 (Neon), 11434 to the GPU SG.
# 3. Launch t3.small (AL2023) with control-plane-user-data.sh, IMDSv2 required, hop limit 1, encrypted root.
# 4. Fill /etc/razekit/{builder,auditor,gateway}.env (Session Manager), then:
#    systemctl start razekit-builder razekit-auditor razekit-gateway
# 5. After the quota is granted: launch the GPU instance (DLAMI, g6.xlarge, tag razekit:role=gpu-inference,
#    150 GB encrypted gp3, gpu-user-data.sh), SG razekit-dev-gpu admitting 11434 from the control-plane SG only,
#    then stop it; set RAZEKIT_GPU_INSTANCE_ID and RAZEKIT_OLLAMA_URL on the gateway.
# 6. In /admin/24-7: Start GPU, then "Test inference" and both acceptance tests for each slot.
```

Steps 1–5 create billable resources and are performed only with the owner's
explicit approval.
