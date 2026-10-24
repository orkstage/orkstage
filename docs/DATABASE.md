# Database

The control plane keeps everything that matters in one PostgreSQL database (18 in the Compose
files). Redis holds queues, rate limit counters and caches only: it can be emptied and rebuilt from
Postgres (see [RUNBOOKS.md](RUNBOOKS.md)). Cloud resources live in the customers' accounts, and
OpenTofu state lives in each target's own state backend (ADR 0005), never here.

## Access

- **Schema and client:** `packages/database` (Prisma 7.10.1, `prisma/schema.prisma`). Every app
  connects through `createPrismaClient(DATABASE_URL)`, which uses the `pg` driver adapter
  (`@prisma/adapter-pg`) with its default pool.
- **Ids** are UUIDv7 strings (time ordered, safe to show), except the three append heavy tables
  (`DeploymentEvent`, `HealthCheckResult`, `AuditEvent`), which use `BigInt` sequences.
- **Timestamps** are `timestamptz(3)`.
- **Tenancy** is enforced in the API, not by row level security: every tenant owned query goes
  through `tenantScope(principal)` or `scopedToTenant(principal, tenantId)`
  (`apps/api/src/common/tenancy.ts`), and a record outside the caller's scope answers 404
  (ADR 0004). Platform staff get an empty scope.

## Models by area

| Area | Models |
|---|---|
| Organization and people | `Organization`, `Tenant`, `User`, `Membership`, `Invitation`, `IdentityProvider`, `ExternalIdentity`, `Session`, `ApiKey` |
| Templates and catalog | `Template`, `TemplateVersion`, `Application`, `ApplicationVersion`, `MarketplaceListing`, `MarketplaceStar` |
| Targets and profiles | `CloudTarget`, `Profile`, `ProfileTarget` |
| Instances | `Instance`, `InstanceTransition`, `InstanceResource`, `Domain` |
| Deployments | `Deployment`, `DeploymentStep`, `DeploymentEvent`, `TriggerRun`, `ImportJob` |
| Health and incidents | `HealthCheckResult`, `StatusComponent`, `Incident`, `IncidentUpdate`, `MaintenanceWindow`, `AlertRule` |
| Status pages | `StatusPage`, `StatusSubscription` |
| Notifications and integrations | `Notification`, `NotificationPreference`, `NotificationDelivery`, `WebhookEndpoint`, `WebhookDelivery` |
| Platform | `AuditEvent`, `FeatureFlag`, `PlatformSetting` |

Secrets never sit in these tables as values. Credentials and keys are secret references
(`env://`, `aws-sm://` and so on) resolved at use; tokens (sessions, API keys, invitations,
status subscriptions) are stored as SHA-256 hashes; webhook signing secrets are encrypted with
`ENCRYPTION_KEY`.

## Rules the schema file does not show

Prisma cannot express some rules, so they live in migration SQL. Change them with a new migration,
never by editing an applied one.

| Rule | Migration |
|---|---|
| `AuditEvent` is append only: a trigger refuses every `UPDATE` and `DELETE` | `20261004000000_init` |
| One open incident per `dedupKey` (partial unique index `Incident_dedupKey_open_key`); workers treat the conflict as "already open" | `20261011090000_incident_dedup` |
| Target names unique per tenant (`CloudTarget_tenant_name_key`) | `20261016170000_target_environment` |
| Tenant limits replace plans; old plan values moved to tags (ADR 0007) | `20261017090000_tenant_limits` |
| Profile names unique, one default profile (`Profile_name_key`, `Profile_default_key`) | `20261017120000_profiles` |
| A published template version is frozen: a trigger refuses changes to its content (`TemplateVersion_frozen`) | `20261018110000_template_lifecycle` |

There are no `CHECK` constraints: value rules are validated by the contracts (Zod) at the API.

## Migrations and seed

| Command | What it does |
|---|---|
| `pnpm db:generate` | Generates the Prisma client |
| `pnpm db:migrate` | Development only: creates a migration from schema changes and applies it |
| `pnpm db:deploy` | Applies pending migrations; what production runs |
| `pnpm db:seed` | Runs the built seed (`dist/seed.js`) |

`prisma.config.ts` and the seed read `../../.env` when it exists. In Compose the `migrate` service
runs `db:deploy` and `db:seed` before the API and worker start.

The seed is idempotent and safe to run on every start. It always creates the organization
(`ORGANIZATION_NAME`), the platform owner (`PLATFORM_OWNER_EMAIL`), the built in templates and the
platform alert rules. Demo tenants, targets and instances are added only outside production or
with `SEED_DEMO_DATA=true`.

Migrations only move forward. Before an upgrade, back up the database; to roll back, restore that
backup and run the previous release (see the site's upgrades page).

## Growth and retention

| Table | Grows with | Pruned |
|---|---|---|
| `HealthCheckResult` | Every health check (every `HEALTH_CHECK_INTERVAL_SECONDS`, per resource) | Older than `HEALTH_HISTORY_DAYS` (30 by default), on every tick |
| `DeploymentEvent` | Provider progress lines of every deployment | Older than `DEPLOYMENT_EVENT_RETENTION_DAYS` (365 by default; 0 keeps them) |
| `Session`, `Invitation` | Sign ins and invitations | 30 days after they expired, were revoked or were accepted |
| `Notification`, `NotificationDelivery`, `WebhookDelivery` | Every event | Older than `NOTIFICATION_RETENTION_DAYS` (90 by default); pending deliveries stay |
| `AuditEvent` | Every audited action | Never: append only. Retention or export is an Enterprise topic (`audit.export`) |

The worker's housekeeping prunes once an hour across all workers (a Redis claim), in batches of
5000 rows, so a large first run spreads over several hours instead of holding long locks.

Resources that are destroyed are marked `DELETED`, not removed, so an instance keeps its history.
Housekeeping also resolves automated incidents whose instance, resource or metric rule is gone and
fails deployments stuck past `TOFU_TIMEOUT_MINUTES + 15`.

## Backup and restore

The control plane database is the only store you must back up. Use point in time recovery on a
managed Postgres, or a scheduled `pg_dump`. The recovery objectives, the steps and the order of the
restore are on the site (self hosting, backups and disaster recovery). Two rules matter here:

- Keep `ENCRYPTION_KEY` and `SESSION_SECRET` with the backup. Without the same `ENCRYPTION_KEY`,
  restored webhook signing secrets cannot be read.
- After a restore, health checks and drift scans compare the database with the real resources. A
  resource created after the backup was taken is not known to the restored database: drift and the
  import flow are how it comes back.
