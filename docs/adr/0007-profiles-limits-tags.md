# ADR 0007: Profiles, tenant limits and template tags instead of plans

**Status:** accepted on October 16, 2026 (owner decisions in orkstage-dev `docs/next-items.md`,
item N4). Replaces the plan part of the tenancy model and the default targets of N3.

## Context

A tenant is on a **plan** (`FREE`, `SANDBOX`, `STARTER`, `GROWTH`, `SCALE`). The plan's
entitlements carry quotas (instances, services, CPU, memory, replicas, database size, domains),
switches (multicloud, several regions, autoscaling, custom domains, custom templates, custom cloud
accounts), retention and support levels, and feature flags. Templates must list the plans they
allow (`spec.plans`) and name a size profile (`metadata.profile`). In practice:

- Plans read like pricing tiers, but OrkStage is self hosted and the open source and Enterprise
  split is done by license keys, not plans. Operators asked for limits per tenant, not tiers.
- Only `maxInstances` is enforced by the API; the template compiler checks services, CPU, memory,
  replicas, database size, domains, autoscaling, custom domains and backup retention.
  `maxStorageGiB`, `customTemplates` and `customCloudAccounts` are never enforced, and the plan
  feature flags (`CUSTOM_TEMPLATES`, `ADVANCED_SCALING`, `DRIFT_DETECTION`) are not real flags.
- `spec.plans` couples every template to the tier names, so a template cannot be used by a tenant
  on another tier even when its resources fit.
- N3 added one **default cloud target** per tenant scope, provider and environment. It covers
  "which account for production" but not "which region", and it cannot express two named setups
  for the same environment (for example production in Europe and production in Brazil).

## Decision

### 1. Tenant limits replace plans

- `Tenant.limits` (JSON, every field optional, absent means unlimited): `maxInstances`,
  `maxServicesPerInstance`, `maxVcpuPerInstance`, `maxMemoryGiBPerInstance`,
  `maxReplicasPerService`, `maxDatabaseGiBPerInstance`, `maxDomainsPerInstance`,
  `maxBackupRetentionDays`. Platform owners and admins edit them (the `TenantLimits` subject that
  replaces `Plan`); tenant roles only read them.
- Enforcement: `maxInstances` at instance creation, as today (`QUOTA_EXCEEDED`). The others in
  the compiler, in a `limits` stage that replaces the `plan` stage, with codes `LIMIT_MAX_SERVICES`,
  `LIMIT_MAX_VCPU`, `LIMIT_MAX_MEMORY`, `LIMIT_MAX_REPLICAS`, `LIMIT_MAX_DATABASE`,
  `LIMIT_MAX_DOMAINS` and `LIMIT_BACKUP_RETENTION`, plus `AUTOSCALING_DISABLED` and
  `CUSTOM_DOMAINS_DISABLED` for the switches below. The plans' `maxStorageGiB` is dropped: no
  template resource besides databases has a size to count. Template validation without a tenant
  (the template pages, the marketplace preview) skips the stage; `tenantId` on the validation
  endpoints checks one tenant.
- Switches become **feature flags** with tenant overrides, which already exist (`FeatureFlag` with
  an optional `tenantId`): `MULTI_CLOUD`, `MULTI_REGION`, `AUTOSCALING`, `CUSTOM_DOMAINS`, all on
  by default. The `multi-cloud-entitlement` policy becomes `multi-cloud-allowed` and reads the two
  flags. `customTemplates` and `customCloudAccounts` are dropped (they were never enforced: roles
  already decide who publishes templates and registers targets), and so are the log and metric
  retention days, advanced alerts, the incident level and the support level, which nothing reads.
- Flag resolution becomes tenant override, then platform override, then default; the plan step
  goes away.
- `Plan`, `Tenant.planId`, `GET /plans`, `planCode` in requests, `TenantDto.plan`,
  `ListingDto.plans`, `PLAN_CODES` and the `platform:plan` resource tag are removed. Removing the
  tag shows as an in place tag update on the next deployment of each instance.

**Migration.** For every tenant, the entitlements of its plan become `Tenant.limits` (the numbers
it has today, so nothing changes for existing tenants), and every switch its plan turned off
becomes a tenant override set to off. Then `Tenant.planId` and `Plan` are dropped.

### 2. Profiles replace default targets

- A **profile** is a named setup for an environment: `Profile { id, tenantId?, name, environment,
  isDefault, targets: [{ provider, targetId, region? }] }`. `tenantId` is null for profiles that
  platform staff share with every tenant, like shared targets. Names are unique per tenant scope,
  ignoring case. At most one target per provider in a profile, and each target must be usable by
  that tenant and serve the profile's environment (or `any`).
- One default profile per tenant scope and environment (partial unique index, as N3 did for
  targets). `environment` takes the target environments (`production`, `staging`, `development`,
  `sandbox`, `any`).
- An instance may name a profile at creation (`profileId`); otherwise OrkStage uses the default
  profile of the instance's environment: the tenant's own before a shared one, the exact
  environment before `any`. Each slot left unbound gets the profile's target for the first
  provider in the slot's `providers` list that the profile has, with the profile's region for that
  provider, else the target's default region. Bindings stay explicit data on the instance, and
  `Instance.profileId` records where they came from; editing a profile later never moves existing
  instances.
- `CloudTarget.isDefault` and `POST /cloud/targets/{id}/default` are removed.
- API: `GET /profiles` (own and shared), `POST /profiles`, `GET`, `PATCH` and `DELETE
  /profiles/{id}`, `POST /profiles/{id}/default`. Platform staff manage shared profiles; tenant
  owners and admins manage their tenant's. Deleting a profile leaves instances as they are.

**Migration.** For every tenant scope and environment with a default target, a profile named after
the environment (for example "production") is created with those targets and marked default.
Then `isDefault` is dropped. The seed creates the shared default profile "Simulation" (environment
`any`) with the three simulated targets.

### 3. Template tags replace plans and size profiles

- `metadata.tags`: optional, free form, lowercase words (`^[a-z0-9][a-z0-9 ]{0,31}$`), at most 20.
  The marketplace shows a template's tags next to its listing's categories and tags, and search
  covers them.
- `spec.plans` and `metadata.profile` are accepted and ignored for one release, with the warnings
  `PLANS_DEPRECATED` and `PROFILE_DEPRECATED` (the second also because "profile" now means the
  setup above). The release after rejects them. Built in and marketplace templates move their old
  values to tags (for example `starter`, `sandbox`).
- The CLI scan stops choosing a plan; it suggests tags from what it found (`containers`,
  `postgres`, `static site`).

## Consequences

- Operators set real limits per tenant instead of choosing among five tiers, and any template whose
  resources fit can be used by any tenant.
- Profiles give names to environments with their accounts and regions, which is what N3 default
  targets approximated, and the console can offer "Production Europe" or "Production Brazil" in
  the instance wizard.
- This is a breaking change of the API and the template schema before 1.0. The API has no
  compatibility window (nothing is released); templates get one release of warnings.
- Work, in this order, each part with its console, CLI and docs changes:
  1. Template tags; `spec.plans` and `metadata.profile` deprecated.
  2. Tenant limits and flags; plans removed.
  3. Profiles; default targets removed.
