# ADR 0004: Tenancy, sessions and authorization

**Status:** accepted on October 4, 2026

## Decision

- A shared database with an explicit `tenantId` on every row a tenant owns (pool model).
  Isolation is enforced in layers: request principal, then query scoping by membership
  (`tenantScope`), then a CASL check on the loaded record, then the audit log. Foreign records
  are reported as not found.
- CASL rules are defined once (`packages/authorization`) and sent to the web console through
  `/me`, only to decide what to show. The API is authoritative.
- Opaque sessions on the server instead of JWTs: instant revocation, nothing sensitive in the
  browser, and a simple CSRF story (a custom header and no CORS).
- OIDC providers are configuration (`OIDC_<KEY>_*`). External identities are keyed per
  provider, and accounts are linked by email only when the provider verified it.

## Consequences

Row level security in Postgres can be added later as another layer without API changes. A
dedicated database or schema per tenant (silo model) remains possible for Scale customers, but
the control plane does not need it, because it stores no customer workload data.
