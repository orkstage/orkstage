# Contributing to OrkStage (core)

Thanks for helping. This file covers what is specific to this repository. The organization
guide ([CONTRIBUTING.md in orkstage/.github](https://github.com/orkstage/.github/blob/main/CONTRIBUTING.md))
covers the workflow, commit style, the CLA and the code of conduct.

## Set up

Requirements: Node 24+, pnpm 12, Docker.

```bash
cp .env.example .env
pnpm install
pnpm local:up                  # Postgres, Redis and Mailpit
pnpm build
pnpm db:deploy && pnpm db:seed
pnpm dev
```

`pnpm local:aws` starts MiniStack, a local AWS emulator. The seed registers it as the target
**Local AWS (MiniStack)**, so you can test real OpenTofu runs without an AWS account.

## Checks before a pull request

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm format:check
```

CI runs the same steps against Postgres and Redis, applies the migrations and runs the seed twice
to prove it is idempotent. When you change the AWS adapter or a module, also run the contract
test against the emulator: `MINISTACK_E2E=1 pnpm --filter @orkstage/cloud-aws test`.

## Where things go

| Change | Place |
|---|---|
| Domain rules (lifecycles, naming, plans) | `packages/domain`, no framework or cloud SDK imports |
| Template schema and validation | `packages/templates` |
| A new cloud provider | a new `packages/cloud-<provider>` implementing the adapter contract in `packages/cloud-core` |
| Request and response shapes | `packages/contracts` (shared with the console and the CLI) |
| Database schema | `packages/database/prisma/schema.prisma`, then `pnpm db:migrate` |
| Enterprise features | `ee/` directories only; core code never imports from `ee/` |

Significant design changes start with an ADR in [`docs/adr`](../docs/adr).

## Ground rules

- Be exact about status. Simulated providers stay labeled as simulated.
- No secrets in code, fixtures, logs or OpenTofu state.
- Tenant isolation is checked on every record: scope queries by membership and check the loaded
  record with CASL.
