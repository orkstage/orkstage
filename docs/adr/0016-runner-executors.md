# ADR 0016: OpenTofu runs on Docker, ECS or Kubernetes

**Status:** accepted on October 24, 2026 (orkstage-dev `docs/open-items.md`, item 17;
`docs/aws-items.md`, A14). Built: the executor interface, the ECS and Kubernetes executors and
their configuration. The Kubernetes executor was checked against a real cluster (k3s); the ECS
executor has unit tests and waits for a live AWS account (A1).

## Context

The worker runs every OpenTofu command in a throwaway container started through the Docker socket.
That keeps OpenTofu out of the control plane process, but the socket is root on the host: anything
that takes over the worker takes over the machine. On a managed container platform there is often
no Docker daemon at all. Installations on AWS want ECS tasks with a scoped IAM role; installations
on Kubernetes want Jobs with a scoped service account.

## Decision

1. **An executor interface.** `TofuRunner` keeps everything that is about OpenTofu (work
   directories, saved plans, validation, parsing, drift) and hands the commands to a
   `TofuExecutor`. `TOFU_RUNNER` picks one: `docker` (the default, unchanged), `ecs` or
   `kubernetes`.

2. **One session per operation.** An operation (apply, plan, drift scan, destroy) is one session:
   `init`, `validate`, then its commands, stopping at the first failure. Docker still starts a
   container per command; ECS and Kubernetes start one task or Job per session, because a task
   takes tens of seconds to start.

3. **A shared work volume.** The worker writes the configuration and reads the results in its work
   directory (`TOFU_WORK_DIR`); the runner mounts the same volume (`TOFU_REMOTE_WORK_DIR`,
   `/workspace` by default): EFS on ECS, a ReadWriteMany claim on Kubernetes. The provider plugin
   cache lives on the same volume. The runner image carries the module library
   (`TOFU_MODULES_IN_IMAGE=true` is required).

4. **Credentials never enter a definition or an API call.** The worker writes the session's
   environment to a file in the work directory that only its user can read; the session script
   reads it and deletes it before OpenTofu starts, and the worker deletes it again afterwards in
   case the runner never started. RunTask parameters are recorded by CloudTrail and Job manifests
   are readable by anyone who can read Jobs, so neither carries a secret. The task or Job receives
   one fixed shell command: change to the work directory and run the session script.

5. **Results come back as files.** Each command's output, errors and exit code are written next to
   the script and read by the worker, so nothing depends on a log service. A runner that stops
   early (did not start, timed out, was cancelled, image could not be pulled) is reported with the
   platform's reason.

6. **The runner runs as the worker's user, locked down.** Both must read and remove what the other
   wrote, so the platform image's user has a fixed uid (10001). Kubernetes Jobs run as the worker's
   uid and gid, non root, with no service account token, no privilege escalation, no capabilities,
   a read only root file system (an `emptyDir` at `/tmp`), `backoffLimit: 0`, a deadline equal to
   `TOFU_TIMEOUT_MINUTES` and automatic cleanup. The ECS task definition sets the same user, a read
   only root file system and no task role: the runner needs no AWS permissions of its own.

7. **Cancel and timeout stop the runner.** ECS: `StopTask`; Kubernetes: the Job is deleted, which
   stops its pod. The worker needs only `ecs:RunTask` (on the runner task definition, in the
   cluster), `ecs:DescribeTasks`, `ecs:StopTask` and `iam:PassRole` on the execution role; or
   `create`, `get` and `delete` on Jobs and `list` on pods in one namespace
   (`infra/aws/orkstage-tofu-runner-*.json`, `infra/kubernetes/tofu-runner.yaml`).

## Consequences

- An installation on ECS or Kubernetes needs no Docker socket, and the worker can run as an
  unprivileged user.
- Every session pays the start time of a task or pod (seconds on Kubernetes with a cached image,
  tens of seconds on Fargate). One session per operation keeps that to one start per resource and
  step.
- The credentials file sits on the shared volume for the moments between the worker writing it and
  the runner reading it. The volume must be encrypted at rest and in transit (EFS with transit
  encryption, an access point that pins the user) and reachable only by the worker and the runner.
- TOFU_TIMEOUT_MINUTES now bounds a whole session on ECS and Kubernetes (on Docker it still bounds
  each command); the AWS credential lifetime already outlives it.
