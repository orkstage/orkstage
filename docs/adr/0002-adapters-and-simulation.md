# ADR 0002: Provider adapters, capability catalogs and simulation

**Status:** accepted on October 4, 2026

## Decision

- `CloudProviderAdapter` (`packages/cloud-core`) is the only way the platform touches a cloud.
  It exposes `validateTarget`, `capabilities`, an idempotent `ensureResource`,
  `deleteResource`, `getResource`, `checkHealth`, and optional logs and metrics. The
  specification's separate create and update calls are merged into `ensureResource` (converge to
  the desired state), so retries cannot create duplicates.
- The mapping from logical resource to implementation is **data**: capability catalogs with
  features, regional gaps and static pricing. A provider neutral resolver reads them and returns
  suggested alternatives when nothing fits.
- A deterministic `mock` provider simulates AWS, Azure or OCI per target (`config.simulate`),
  with injectable failures, latency, health overrides and drift. Its state lives in Redis.
  Everything simulated is labeled (`simulated: true` on deployments, targets and instances).
- A shared contract test suite (`@orkstage/cloud-core/testing`) runs against every adapter.
- AWS resource operations threw `AWS_PROVISIONING_NOT_IMPLEMENTED` until the OpenTofu runner
  existed, instead of pretending to work (spec §83). They now provision through OpenTofu
  ([ADR 0005](0005-opentofu-state.md)).

## Consequences

The Azure and OCI catalogs currently live in `cloud-mock` as simulation catalogs; they move to
their own packages when real adapters are written. Adding a provider never touches domain code.
