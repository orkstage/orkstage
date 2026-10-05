# OrkStage

**Command every stage of your cloud.** Raw scale. Precise control.

OrkStage is a control plane for provisioning and operating isolated customer environments ("instances")
across one or several clouds. An instance is a **logical environment** — API, workers,
database, cache, queue, storage, ingress, DNS — and **each resource is placed independently**,
so one instance can run its API on AWS, its database on Azure and its storage on OCI.

> **Status.** AWS resources are provisioned for real with OpenTofu — locally against
> [MiniStack](https://ministack.org) (an MIT-licensed AWS emulator that runs real containers
> for ECS, RDS and ElastiCache) or against a real account via cross-account roles. Azure and
> OCI are still **simulated** by a deterministic provider; simulated resources are labelled as
> such everywhere. See [What works today](#what-works-today) and [docs/ROADMAP.md](docs/ROADMAP.md).

## Quick start (no cloud credentials needed)

Requirements: Node 24+, pnpm 12, Docker.

```bash
cp .env.example .env
pnpm install
pnpm local:up                 # Postgres, Redis, Mailpit
pnpm build                    # all packages and apps
pnpm db:deploy && pnpm db:seed
pnpm --filter @co/api start   # http://localhost:4000/api/docs
pnpm --filter @co/worker start
pnpm --filter @co/web dev     # http://localhost:3000
```

Sign in with the development login as `admin@example.local` (platform owner),
`operator@example.local` (operator) or `customer@example.local` (owner of tenant Acme).
Emails land in Mailpit at http://localhost:8025.

The seed creates the reference instance **Acme Production** (spec §42.17 topology: API on
simulated AWS ECS Fargate + ECR + ALB + Route 53, Postgres on simulated Azure Flexible Server,
object storage on simulated OCI). Open it, check *Plan & cost*, deploy, and watch progress.
Use the *Simulate* controls on a resource to trigger an outage → automated incident → email →
auto-resolve.

## Run the full platform in Docker Compose

Only Docker is required (no Node/pnpm on the host):

```bash
docker compose -f infra/local/docker-compose.yml --profile platform --profile aws-emulator up -d --build --wait
# or, with pnpm installed: pnpm platform:up
```

| Service | URL / role |
|---|---|
| web | http://localhost:3000 — console (dev login: `admin@example.local`) |
| api | http://localhost:4000/api/docs — Control API + OpenAPI |
| worker | deployments, health checks, notifications; starts OpenTofu runner containers |
| migrate | one-shot: `prisma migrate deploy` + idempotent seed |
| tofu-runner | builds `orkstage/tofu-runner:local` (OpenTofu 1.12.7 + modules) |
| ministack | http://localhost:4566 — local AWS |
| mailpit | http://localhost:8025 — emails |
| postgres / redis | localhost:5432 / 6379 |

Logs: `pnpm platform:logs` (or `docker compose … logs -f api worker web`). Stop:
`pnpm platform:down` (volumes are kept; add `-v` to wipe data).

How it is wired: one image (`infra/docker/platform.Dockerfile`) runs api, worker, web and
migrate with different commands. The worker reaches Docker through the socket and launches
`orkstage/tofu-runner:local` containers on the compose network; working directories live in the
named volume `orkstage-tofu-work` (the daemon cannot see paths inside the worker container) and
providers are cached in `orkstage-tofu-plugins`. Inside the network MiniStack is
`http://ministack:4566` (`AWS_EMULATOR_ENDPOINT`), while links shown in the console keep
`http://localhost:4566`. The compose file runs in `NODE_ENV=development` (dev login, non-Secure
cookies over http) — it is for local use only, as is the Docker socket mount.

Rebuild after code changes: `docker compose -f infra/local/docker-compose.yml --profile platform build`
then `up -d`. The host workflow below still works when you prefer hot reload.

## License

OrkStage is open core. Everything is licensed under the **GNU AGPL-3.0** ([LICENSE](LICENSE)),
except directories named `ee/`, which are under the OrkStage Enterprise License
([apps/api/src/ee/LICENSE](apps/api/src/ee/LICENSE), draft) and activated with a license key
(`ORKSTAGE_LICENSE_KEY`). Without a key you run the full Community edition. See
[docs/OPEN_CORE.md](docs/OPEN_CORE.md) for the feature split and licensing model.

## Local AWS with MiniStack

```bash
pnpm local:aws    # starts MiniStack on :4566 (needs the Docker socket — local use only)
```

The seed registers the target **Local AWS (MiniStack)** and the instance **Acme Staging (local
AWS)** (`starter-standard`: VPC, ECR, ALB, RDS Postgres, Valkey, SQS, two ECS Fargate services,
Route 53 + ACM). Validate the target, deploy the instance, and the worker runs OpenTofu in
throwaway containers (`ghcr.io/opentofu/opentofu`) with one isolated state per resource in
MiniStack's S3. The API's ALB is reachable at `http://localhost:4566/_alb/<lb-name>/` (shown as
the ingress `url` output). You can also bind only the AWS slot of `multicloud-reference` to
MiniStack and keep Azure/OCI simulated.

Opt-in adapter contract test against the emulator: `MINISTACK_E2E=1 pnpm --filter @co/cloud-aws test`.

## Repository layout

```text
apps/
  api/        NestJS + Fastify control API (auth, tenancy, CASL, templates, instances, …)
  worker/     BullMQ worker: deployment workflow, health monitor, notifications
  web/        Next.js console
packages/
  domain/         pure domain: lifecycles, health model, plans, naming, tags, idempotency
  templates/      provider-neutral template schema, validation pipeline, built-in templates
  cloud-core/     provider adapter contract, capability model + resolver, contract tests
  cloud-aws/      AWS catalog + adapter (OpenTofu provisioning, SDK health checks, AssumeRole)
  iac/            OpenTofu runner (throwaway containers, JSON output parsing, cancellation)
  cloud-mock/     deterministic simulation provider (+ simulated Azure/OCI catalogs)
  provisioning/   compiler, policies, cost estimate, plan diff, DAG executor, workflow
  authorization/  CASL abilities shared by API and web
  contracts/      HTTP request schemas, response types, queue contracts
  runtime/        config validation, logging, secrets, adapter registry wiring
  database/       Prisma schema, migrations, seed
infra/local/      docker compose for local development (+ MiniStack profile)
infra/tofu/       OpenTofu modules per logical resource kind (aws/*)
docs/             architecture, API map, ADRs
```

## Useful commands

| Command | What it does |
|---|---|
| `pnpm build` / `pnpm test` / `pnpm typecheck` | across the workspace (dependency order) |
| `pnpm db:migrate` | create a migration after editing `schema.prisma` |
| `pnpm local:down` | stop local infrastructure |

## What works today

Verified end to end locally (API + worker + Postgres + Redis + Mailpit):

- Dev login and session cookies; OIDC framework (Entra configured via env, untested without an
  app registration); CSRF header guard; rate limits; structured logs with redaction.
- Tenant isolation (query scoping + CASL on every record); 7 roles.
- Templates: 6 built-ins, schema/semantic/plan/capability/policy validation, versioning,
  immutable publishing, clone, explicit instance upgrade.
- Compile + preview: per-resource placement, capability resolution with suggested
  alternatives, cross-cloud connectivity strategy, policies, approximate cost, plan diff.
- Async deployments: DAG execution with parallel branches, retries of transient failures,
  failure isolation (skipped dependents only), resume after worker restart, cancel, retry
  failed resources only, approval gate for high-risk production changes, per-target
  concurrency slots.
- Health monitor → instance health → private status page → automated incidents with
  dedup/cooldown/auto-resolve → in-app + email notifications.
- Dependency-aware destroy with typed confirmation; append-only audit log (DB-enforced).

- Real AWS provisioning with OpenTofu (verified on MiniStack): no secrets in state (write-only
  attributes), SDK health checks, CloudWatch logs.
- Console: OrkStage branding (dark default, light option), dashboards with ECharts, instance
  topology diagram (React Flow) with "Copy as Mermaid", deployment timeline, and a drag-and-drop
  template builder that edits the same YAML with live validation.

Not yet: Azure/OCI/GCP adapters, GitHub login, pricing APIs, metrics/traces export for real
targets, `tofu plan` preview before apply, E2E browser tests. Full gap analysis:
[docs/ROADMAP.md](docs/ROADMAP.md).
