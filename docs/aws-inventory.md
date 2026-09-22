# AWS inventory and execution-plane plan

**Performed:** 2026-09-22, read-only.
**Method:** AWS MCP connector, `boto3` describe/list calls only.
**Mutations:** none. No resource was created, modified or deleted.

The account identifier is deliberately not written into this file or into the
policy documents beside it; those use `${AWS_ACCOUNT_ID}` and are substituted at
apply time. An account id is not a credential, but it is an enumeration aid, and
these files are in a git repository.

## Identity

| Field | Value |
| --- | --- |
| Principal type | **root** |
| Root access keys | **none** (`AccountAccessKeysPresent: 0`) |
| Root MFA | enabled |
| Account alias | not set |
| Enabled regions | 18 |

The MCP connector therefore holds a temporary root session rather than a
long-lived key. That is the better of the two postures, and it is still root.

## A. Existing resources

Swept across all 18 enabled regions: `ec2` (VPCs, subnets), `ecr`, `ecs`, `sqs`,
`logs`, `secretsmanager`, `lambda`; plus global `s3` and `iam`.

| Resource | Found |
| --- | --- |
| VPCs | One **default** VPC per region, all `172.31.0.0/16`, all untagged |
| Subnets | Default subnets only (2–6 per region) |
| ECR repositories | none |
| ECS clusters / services | none |
| SQS queues | none |
| S3 buckets | none |
| Lambda functions | none |
| CloudWatch log groups | none |
| Secrets Manager secrets | none |
| IAM roles | 3, all AWS service-linked (ResourceExplorer, Support, TrustedAdvisor) |
| IAM users | 1 — `razekit-dev-automation` |
| IAM groups, customer-managed policies, OIDC providers | none |

**The account is empty.** Nothing has been provisioned for RazeKit.

### `razekit-dev-automation` as it stands

Created 2026-09-22 04:28 UTC.

| Attribute | Value |
| --- | --- |
| Attached managed policies | `IAMUserChangePassword` **only** |
| Inline policies | none |
| Access keys | **none** |
| MFA devices | 1 |

This is a console user, not an automation identity: it can change its own
password and make no other API call. Phase C is **started, not usable**.

## B. Missing resources

Everything the execution plane needs. See D.

## C. Duplicate risks

**None.** There is nothing to collide with. Two rules apply going forward:

- The **default VPC is reused**, not replaced. A dedicated VPC would need a NAT
  gateway to reach Neon and the model providers, which is standing cost for no
  security gain here: these workers need no inbound access at all, and that is
  enforced by a security group with **zero inbound rules** rather than by
  network topology.
- Every created resource carries the `razekit-dev-` prefix and the tags in D, so
  a later sweep can tell RazeKit's resources from anything else in the account.

## D. Exact resources required

**Region: `us-east-2`** — and this is derived, not preferred. All three Neon
projects (`razekit-dev`, `razekit`, `admin-razekit`) are in `aws-us-east-2`.
Measured from this development host, a single Neon round trip costs **4.1 s** and
the worker-pool test took **58 s**; the fix is co-location, and the database
already fixes the region. Placing workers anywhere else would be choosing that
latency deliberately.

| Resource | Name | Notes |
| --- | --- | --- |
| ECR repository | `razekit-dev-worker` | immutable tags, scan on push |
| ECS cluster | `razekit-dev` | Fargate |
| ECS service | `razekit-dev-worker` | desired count from the queue depth |
| SQS queue | `razekit-dev-jobs` | visibility timeout ≥ the node lease |
| SQS DLQ | `razekit-dev-jobs-dlq` | redrive after 5 receives |
| S3 bucket | `razekit-dev-artifacts-<account>-us-east-2` | **private**, versioned, public access blocked, lifecycle expiry on `tasks/` |
| Secrets | `razekit-dev/database-url`, `razekit-dev/anthropic-api-key`, `razekit-dev/openai-api-key`, `razekit-dev/principal-secret` | values supplied by the owner, never by this repository |
| Log group | `/razekit-dev/worker` | retention set explicitly, not "never expire" |
| Security group | `razekit-dev-worker` | **no inbound rules**; egress 443 only |
| IAM role | `razekit-dev-task-execution-role` | ECS pulls the image and injects secrets |
| IAM role | `razekit-dev-task-role` | what the running worker itself may do |

Required tags on every resource: `Project=razekit-dev`, `Environment=production`,
`Owner=razekit`, `CostCenter=razekit-dev`, `ManagedBy=iac`.

## E. Least-privilege permissions

Three separate policies, in `infra/aws/policies/`. The split is the point:
control-plane rights and runtime rights are never held by the same principal.

| Policy | Principal | Deliberately excluded |
| --- | --- | --- |
| `razekit-dev-automation.json` | the deploy identity | **cannot read any secret value** (`DescribeSecret` only), cannot consume the queue, cannot write to the artifact bucket |
| `razekit-dev-task-execution-role.json` | ECS, at container start | cannot touch SQS, S3 or any other repository |
| `razekit-dev-task-role.json` | the running worker | cannot deploy, cannot change infrastructure, cannot list the artifact bucket outside `tasks/` |

Notes on the three wildcards that remain, each unavoidable:

- `ecr:GetAuthorizationToken` has no resource form in IAM.
- `ecs:RegisterTaskDefinition` cannot be resource-scoped; the `iam:PassRole`
  condition is what actually contains it, restricting the roles a task
  definition may assume to the two above and only when passed to ECS.
- `ec2:Describe*` is read-only and cannot be resource-scoped.

`AdministratorAccess` is not requested and is not required.

## Required human action

These are account-level acts. They are listed rather than performed: §45 of the
mandate scopes this pass to read-only, and a permissions grant is exactly the
change that should not happen as a side effect of an inventory.

1. Attach `razekit-dev-automation.json` to the `razekit-dev-automation` user as a
   customer-managed policy, substituting the account id.
2. Decide how that identity authenticates. **Preferred:** GitHub OIDC with an
   assumed role, so no long-lived key exists at all. **Acceptable:** one access
   key, stored in the deployment secret store, rotated on a schedule.
3. Leave root without access keys. It currently has none — keep it that way.

Until step 1 and step 2 are done, the AWS execution plane (Phase P) is blocked.
Nothing else in the roadmap is blocked by it.
