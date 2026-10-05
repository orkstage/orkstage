# ADR 0004 — Tenancy, sessions and authorization

**Status:** accepted (2026-10-04)

## Decision

- Shared database, explicit `tenantId` on every tenant-owned row (pool model). Isolation is
  enforced in layers: request principal → query scoping by membership (`tenantScope`) → CASL
  check on the loaded record → audit. Foreign records are reported as not found.
- CASL rules are defined once (`packages/authorization`) and sent to the web console via `/me`
  for feature visibility only; the API is authoritative.
- Server-side opaque sessions instead of JWTs: instant revocation, nothing sensitive in the
  browser, simple CSRF story (custom header + no CORS).
- OIDC providers are configuration (`OIDC_<KEY>_*`), keyed external identities, email linking
  only on provider-verified email.

## Consequences

Row-level security in Postgres can be added later as a further layer without API changes.
A dedicated database/schema per tenant (silo model) remains possible for Scale customers, but
is not needed for the control plane, which stores no customer workload data.
