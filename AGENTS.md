# AGENTS.md: orkstage (control plane)

Guide for AI coding agents and the developers working with them. Read it before changing code
here. Human oriented docs live in `docs/` (start with `docs/ARCHITECTURE.md` and `docs/adr/`).

## What this repository is

The OrkStage control plane: a NestJS API, a BullMQ worker and the TypeScript packages behind them.
It turns provider neutral templates into resources on AWS, Azure, Google Cloud, OCI, DigitalOcean,
Vultr, CoreWeave, Magalu Cloud, Vercel, Render and Supabase, then watches them (health, drift,
incidents, triggers). The web console, CLI, OpenTofu modules and site are separate repositories;
`orkstage-dev` checks them all out together (see "Working across repositories").

## Layout

| Path | What lives there |
|---|---|
| `apps/api` | NestJS 12 on Fastify. Controllers per area (`catalog/`, `instances/`, `deployments/`, `integrations/`, `ops/`; `ee/` is the private Enterprise submodule, absent in public clones), guards and helpers in `common/`, process wiring in `infra/` |
| `apps/worker` | BullMQ consumers: deployments (`runner.ts`), health and incidents (`health.ts`), drift (`drift.ts`), triggers (`triggers.ts`), notifications and webhooks |
| `packages/domain` | Pure domain: providers and `PROVIDER_INFO`, feature flags, tenant limits, lifecycle state machine, naming, tags, errors. No I/O |
| `packages/contracts` | HTTP contract shared with the console and CLI: zod request schemas, response DTOs, queue names, `PROVIDER_FORMS`. Dependency free on purpose |
| `packages/templates` | Template schema (`schema.ts`), validation stages, dependency graph, variables, built in templates in `builtin/*.yaml` |
| `packages/provisioning` | Compiler (template to resolved infrastructure), policies, cost, plan diff, provider plans, DAG executor, triggers logic |
| `packages/cloud-core` | Adapter contract (`types.ts`), registry, capability resolver, shared helpers, contract test suite (`./testing`) |
| `packages/cloud-tofu` | Base class for OpenTofu providers: state stores, backends, root config, runner env |
| `packages/cloud-<provider>` | One adapter per provider. `cloud-aws` predates the base and has its own implementation; `cloud-vercel`, `cloud-render`, `cloud-supabase` use REST APIs, not OpenTofu |
| `packages/cloud-mock` | Deterministic simulation provider that imitates any provider's real catalog |
| `packages/iac` | OpenTofu runner: one throwaway container per command |
| `packages/runtime` | Config loading, logger, Redis, secret resolvers, `SecretBox`, adapter registry wiring |
| `packages/database` | Prisma 7 schema, migrations, generated client, seed |
| `packages/authorization` | CASL abilities shared by API and console |
| `packages/licensing` | Edition and license checks for enterprise features |
| `infra/` | Local Compose for infrastructure only, Docker images, the AWS deployment role template |

## Commands

Run from the repository root (pnpm 12, Node 24). Native `tofu` and unsigned binaries may be blocked
on some machines; OpenTofu always runs in containers anyway.

```bash
pnpm install
pnpm build          # every package, in dependency order
pnpm typecheck
pnpm test           # vitest in every package
pnpm -C packages/<name> test        # one package
pnpm db:deploy && pnpm db:seed      # needs DATABASE_URL (local stack: see orkstage-dev)
# API integration tests (tenant isolation, keys, team, audit): after build, on a migrated and
# seeded database with Redis; AUTH_DEV_LOGIN_ENABLED=true. CI runs them on every pull request.
pnpm --filter @orkstage/api test:integration
pnpm audit --audit-level high       # CI runs this
```

Packages consume each other through `dist/`: after changing a package, `pnpm -C packages/<name>
build` before typechecking its dependents.

## Invariants (do not break these)

- **Secrets never land in the database, logs, API responses, OpenTofu config or module outputs.**
  Targets hold a `credentialRef` (`env://NAME`, `aws-sm://name`) resolved at the moment of use.
  Modules publish `secret_ref`, never values. Generated passwords are derived (`SecretBox.derive`)
  or stay in the provider's secret store.
- **Tenant isolation:** every query on tenant data goes through `tenantScope(principal)` and
  `authorize(principal, action, subject, { tenantId })`. A foreign record must look exactly like a
  missing one (404).
- **Routes are closed to API keys by default.** Only routes with `@Scope('<scope>')` accept them.
- **Long work is asynchronous.** Controllers enqueue jobs; the worker does cloud calls.
- **Idempotency:** `ensureResource` with the same idempotency key changes nothing; deployments are
  deduplicated by operation key; job ids collapse duplicates.
- **Desired, known and actual state are different things.** The database records desired and
  known state; providers hold actual state. Never assume a recorded resource still exists.
- **Provider specific code stays in its `cloud-<provider>` package.** No `if (provider === ...)`
  in domain, templates, provisioning or the API.
- **Destroy is never blocked by configuration changes** (feature flags, policies): it runs from the
  last applied snapshot.
- **Providers other than AWS and the simulation provider are disabled by default** behind
  `PROVIDER_<NAME>` feature flags; new providers follow the same rule until tested on live accounts.

## Decided, not built yet

Owner decisions that changes must move toward, not away from. Read the ADR before touching the area.

- **Shared sandbox network** (ADR 0008): `network.strategy: shared` becomes one platform owned
  network per target and region, isolated by per instance security groups, refused in production.
  Do not remove the option from the schema or the `free-validation` template.
- **Provider actions** (ADR 0009): trigger actions move to one provider neutral catalog in
  `packages/domain` (stable id, risk level, minimum role), including release strategies (canary,
  blue/green, smart rollback). Future AI agents may only propose catalog actions. Add new actions
  to the catalog, not as adapter only names.
- **Prices** (ADR 0010): estimates come from a `PriceSource`: the AWS Pricing API first, bundled
  per region tables in each adapter's catalog as the fallback and for providers without an API.
  Every estimate records its source and date. Prices live only in catalog tables.

## How to make common changes

- **New API endpoint:** controller method with `authorize(...)` first, zod body via
  `@ZodBody(schema)` + `@ApiZodBody(schema)` (schema in `packages/contracts`), DTO type in
  `contracts/src/responses.ts`, audit state changing actions with `AuditService.record`, add
  `@Scope` only if API keys should reach it. Register the controller in its module.
- **Schema change:** edit `packages/database/prisma/schema.prisma`, then create a migration folder
  under `prisma/migrations/<timestamp>_<name>/migration.sql`. Generate SQL with
  `npx prisma migrate diff --from-schema <old copy> --to-schema prisma/schema.prisma --script`
  (from `packages/database`). Enum additions use `ALTER TYPE ... ADD VALUE IF NOT EXISTS`.
- **New template resource type or field:** `packages/templates/src/schema.ts` (and
  `RESOURCE_TYPES`), semantic checks in `validation.ts`, features in `provisioning/src/compiler.ts`
  (`requiredFeatures`), cost category in `cost.ts`, status component in
  `apps/worker/src/status.ts`, then the capability in each provider catalog that implements it.
- **New provider:** see `.claude/skills/add-provider/SKILL.md` in `orkstage-dev`. In short: add it
  to `CLOUD_PROVIDERS`, `PROVIDER_INFO`, contracts `PROVIDERS` and `PROVIDER_FORMS`, the Prisma
  enum (migration), a `cloud-<name>` package extending `OpenTofuAdapter` (or implementing
  `CloudProviderAdapter` for an API platform), register it in `packages/runtime/src/adapters.ts`
  and the mock catalogs, modules in `orkstage-modules`, docs page in `orkstage-site`.
- **Adapter capabilities:** catalog entries are data (`catalog.ts`); the resolver picks the
  default or the template's `implementation`. Optional adapter methods (`readSecret`, `actions`,
  `runAction`, `listDeployments`, `getLogs`, `probeExists`, `planResource`, `detectDrift`) light
  up features automatically.

## Tests

- Unit tests sit next to the code (`*.test.ts`, vitest). Adapters run the shared contract suite
  from `@orkstage/cloud-core/testing` and use a fake `fetch` and a fake `TofuRunner`; never call
  real cloud APIs from tests.
- Prefer testing behaviour through public functions (`compileInfrastructure`, `executeApply`,
  adapter methods) over internals.
- End to end checks run against the local stack in `orkstage-dev` (simulation targets need no
  account).

## Style

- TypeScript strict with `noImplicitOverride` and `noUncheckedIndexedAccess`; ESM with `.js`
  import suffixes.
- Short JSDoc on exported things; comments explain why, not what. Match the density of the file
  you are editing.
- Errors: `ProviderError` (adapters) and `DomainError` carry a stable code and a failure class
  (`packages/domain/src/errors.ts`) that drives retries; messages are safe to show and never
  contain secrets or raw provider payloads (use `redact`).
- Prose (docs, comments, user facing messages): plain English, no em or en dashes, no " - " as
  punctuation, no hyphenated prose words ("open source", "multicloud"), no emoji, sentence case
  headings.

## License headers

Every source file starts with an SPDX header: `AGPL-3.0-only`, or
`LicenseRef-OrkStage-Enterprise` in the Enterprise submodule (`apps/api/src/ee`, the private
`orkstage-ee` repository). Code outside `ee/` never imports from it: `apps/api/src/enterprise.ts`
loads its entry point by path when it exists, so the API builds and runs without it. The
submodule is marked `update = none`, so clones skip it; with access, fetch it with
`git submodule update --init --checkout apps/api/src/ee`. CI runs the check; to add missing
headers:

```bash
bash scripts/spdx.sh --fix
```

## Git workflow

Branch from `main`, open a pull request, squash merge when CI (`build-test`) is green. Direct
pushes to `main` are blocked by the pre-push hook from `orkstage-dev`. Commits use the repository
identity configured locally; do not commit `.env` files, state files or anything under `dist/`.
After merging, bump the submodule pin in `orkstage-dev` (also by pull request).

## Working across repositories

| Repository | Role |
|---|---|
| `orkstage` | This repository |
| `orkstage-console` | Next.js console; consumes `@orkstage/contracts`, `domain`, `authorization`, `templates` |
| `orkstage-modules` | OpenTofu modules (`modules/<provider>/<module>`) and the runner image |
| `orkstage-cli` | Rust `ork` CLI and the WebAssembly scan engine used by `/imports` |
| `orkstage-site` | orkstage.io and the docs (the public API reference is generated from this API) |
| `orkstage-dev` | Workspace with all of the above as submodules, Compose stack, scripts |

A change that crosses repositories (new endpoint used by the console, new module input) merges
here first, then in the consumer.
