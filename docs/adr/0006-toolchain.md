# ADR 0006 — Toolchain choices

**Status:** accepted (2026-10-04)

- **pnpm workspaces without Turborepo.** The development machines run a policy that blocks
  executing native binaries from `node_modules` (`turbo.exe` is denied). `pnpm -r` already runs
  scripts in dependency order; Turborepo caching can be added in CI later if build times call
  for it.
- **TypeScript 7.0.** Verified to emit decorator metadata for NestJS. `@nestjs/swagger` still
  declares a TS ≤ 6 peer range; it works, but if a TS 7 incompatibility appears, pin TS 6 in
  `apps/api` only.
- **Prisma 7.10 (not the 8.0 RC tagged `latest`).** Driver adapter `@prisma/adapter-pg`,
  `prisma.config.ts`, ESM client generated into `packages/database/src/generated`.
- **Zod 4** schemas shared between API validation, OpenAPI (`z.toJSONSchema`) and web forms.
- **ESM everywhere** (`module: NodeNext`).
