# ADR 0006: Toolchain choices

**Status:** accepted on October 4, 2026

- **pnpm workspaces without Turborepo.** The development machines run a policy that blocks
  native binaries from `node_modules` (`turbo.exe` is denied). `pnpm -r` already runs scripts in
  dependency order; Turborepo caching can be added in CI later if build times call for it.
- **TypeScript 7.0.** Verified to emit decorator metadata for NestJS. `@nestjs/swagger` still
  declares a peer range of TypeScript 6 or lower; it works, but if an incompatibility with
  TypeScript 7 appears, pin TypeScript 6 in `apps/api` only.
- **Prisma 7.10 (not the 8.0 release candidate tagged `latest`).** Driver adapter
  `@prisma/adapter-pg`, `prisma.config.ts`, and an ESM client generated into
  `packages/database/src/generated`.
- **Zod 4** schemas are shared by API validation, OpenAPI (`z.toJSONSchema`) and the console's
  forms.
- **ESM everywhere** (`module: NodeNext`).
