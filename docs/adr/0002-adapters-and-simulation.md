# ADR 0002 — Provider adapters, capability catalogs and simulation

**Status:** accepted (2026-10-04)

## Decision

- `CloudProviderAdapter` (`packages/cloud-core`) is the only way the platform touches a cloud.
  It exposes `validateTarget`, `capabilities`, idempotent `ensureResource`, `deleteResource`,
  `getResource`, `checkHealth`, optional logs/metrics. The spec's separate create/update calls
  are merged into `ensureResource` (converge to desired state) so retries can't duplicate.
- Logical resource → implementation mapping is **data** (capability catalogs with features,
  regional gaps and static pricing), resolved by a provider-neutral resolver that returns
  suggested alternatives when nothing fits.
- A deterministic `mock` provider simulates AWS, Azure or OCI per target (`config.simulate`),
  with injectable failures, latency, health overrides and drift. Its state lives in Redis.
  Everything simulated is labelled (`simulated: true` on deployments, targets, instances).
- A shared contract test suite (`@co/cloud-core/testing`) runs against every adapter.
- AWS resource operations deliberately throw `AWS_PROVISIONING_NOT_IMPLEMENTED` until the
  OpenTofu runner exists, rather than pretending to work (spec §83).

## Consequences

Azure/OCI catalogs currently live in `cloud-mock` as simulation catalogs; they move to their
own packages when real adapters are written. Adding a provider never touches domain code.
