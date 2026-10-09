# ADR 0005: OpenTofu execution and state

**Status:** accepted on October 4, 2026; supersedes the earlier proposal with the same number

## Decision

- **Isolated runner.** The worker never runs IaC in its own process. Every `tofu` command runs
  in a throwaway container (`ghcr.io/opentofu/opentofu:1.12.7`, pinned) with the module library
  mounted read only and a shared cache volume for provider plugins. Credentials are passed as
  environment variables to that one container only, never in files, command lines or state
  (`packages/iac`).
- **One state per resource** (`orkstage/<physical-name>.tfstate`), not per slot. This keeps the
  platform's own DAG, progress per resource, retries and failure isolation (spec §42.12), and it
  limits the damage of a broken state to one resource. Dependencies flow through module outputs
  passed as inputs; each module emits a `kind` output so the adapter wires them by type.
- **Backend:** S3 with `use_lockfile` locking and encryption. On real AWS, a versioned and
  encrypted bucket created beforehand (`stateBucket` on the target, validated before use). On
  the emulator, the bucket is created on first use. The exact root configuration is stored next
  to the state (`.config.json`), so a destroy never depends on a template that changed since.
- **No secrets in state.** RDS passwords are generated with an `ephemeral` resource and written
  through write only attributes (`password_wo`, `secret_string_wo`); services receive the
  Secrets Manager ARN as an ECS secret. Verified: the state holds `password: null`.
- **The same code for real AWS and MiniStack.** The target configuration switches credentials
  (AssumeRole or the emulator's test keys) and endpoints (`endpointUrl` for the control plane,
  `runnerEndpointUrl` for the runner container).

## Verified locally against MiniStack 1.5.21

VPC, subnets and security groups, ECR, SQS with a dead letter queue, S3, Secrets Manager, RDS
Postgres (a real container), an ElastiCache Valkey replication group (a real container), an ALB
with target groups and listener rules (live data plane at `/_alb/<name>/`), an ECS Fargate
service (a real container, registered in the target group automatically and healthy), Route 53
and ACM. The adapter contract suite passes against it.

## Known gaps

- Drift (resolved): a scheduled refresh only plan per resource reports changes made outside
  OpenTofu at attribute level (`tofu show -json`, names only). Differences in representation
  only (null compared with `{}` or `[]`, set order) are ignored everywhere. A few
  `type.attribute` pairs that MiniStack does not round trip (for example
  `aws_iam_role.inline_policy`) are filtered on emulator targets only.
- MiniStack does not implement Application Auto Scaling: services with `autoscaling` run a fixed
  number of replicas there (logged), while real AWS gets target tracking.
- MiniStack does not serve the public SSM parameter for the ECS optimized AMI, so `ecs-ec2` uses
  a placeholder AMI on the emulator (`ecsAmiId` is optional on real AWS, where SSM is the
  default).
- When the worker itself runs in a container, the runner needs Docker access (the socket or a
  remote builder). A Kubernetes Job or ECS RunTask runner is the production follow up.
