# ADR 0005 — OpenTofu execution and state

**Status:** accepted (2026-10-04), supersedes the proposal of the same number

## Decision

- **Isolated runner.** The worker never runs IaC in-process. Every `tofu` command runs in a
  throwaway container (`ghcr.io/opentofu/opentofu:1.12.7`, pinned) with the module library
  mounted read-only and a shared provider-plugin cache volume. Credentials are passed as
  environment variables for that one container only — never in files, command lines or state
  (`packages/iac`).
- **One state per resource** (`orkstage/<physical-name>.tfstate`), not per slot. This keeps the
  platform's own DAG, per-resource progress, retries and failure isolation (spec §42.12), and
  limits the blast radius of a damaged state to one resource. Dependencies flow through module
  outputs passed as inputs; each module emits a `kind` output so the adapter wires them by type.
- **Backend:** S3 with `use_lockfile` locking and encryption. Real AWS: a pre-provisioned,
  versioned, encrypted bucket (`stateBucket` on the target, validated before use). Emulator: the
  bucket is created on first use. The exact root configuration is stored next to the state
  (`.config.json`) so destroy never depends on a template that changed since.
- **No secrets in state.** RDS passwords are generated with an `ephemeral` resource and written
  through write-only attributes (`password_wo`, `secret_string_wo`); services receive the
  Secrets Manager ARN as an ECS secret. Verified: state holds `password: null`.
- **Same code for real AWS and MiniStack.** The target config switches credentials
  (AssumeRole vs. emulator test keys) and endpoints (`endpointUrl` for the control plane,
  `runnerEndpointUrl` for the runner container).

## Verified locally against MiniStack 1.5.21

VPC/subnets/SG, ECR, SQS (+DLQ), S3, Secrets Manager, RDS Postgres (real container), ElastiCache
Valkey replication group (real container), ALB + target groups + listener rules (live data
plane at `/_alb/<name>/`), ECS Fargate service (real container, auto-registered in the target
group and healthy), Route 53 + ACM. The adapter contract suite passes against it.

## Known gaps

- Drift (resolved): a scheduled refresh-only plan per resource reports out-of-band changes at
  attribute level (`tofu show -json`, names only). Representation-only differences (null vs
  `{}`/`[]`, set order) are ignored everywhere; a few `type.attribute` pairs MiniStack does not
  round-trip (e.g. `aws_iam_role.inline_policy`) are filtered on emulator targets only.
- MiniStack does not implement Application Auto Scaling: services with `autoscaling` run fixed
  replicas there (logged); real AWS gets target tracking.
- MiniStack does not serve the public SSM parameter for the ECS-optimized AMI; `ecs-ec2` uses a
  placeholder AMI on the emulator (`ecsAmiId` on real AWS is optional, SSM is used by default).
- In containerized deployments of the worker the runner needs Docker access (socket or a remote
  builder). A Kubernetes Job / ECS RunTask runner is the production follow-up.
