# Architecture

## Layers

```text
Web console (Next.js)  ──/api rewrite──▶  Control API (NestJS/Fastify)
                                            auth · tenancy · CASL · templates · instances
                                            │ writes intent + enqueues (never runs cloud ops)
                                            ▼
                                   Postgres (desired + known state)   Redis (BullMQ, slots)
                                            ▲
                                            │
                                     Worker (BullMQ)
                       deployment workflow · health monitor · notifications
                                            │
                              Provisioning compiler + DAG executor
                                            │
                                  Adapter registry (cloud-core)
                         ┌──────────────┬───────────────┬──────────────┐
                       AWS            Mock (sim)      Azure*, OCI*, GCP*   (*not yet)
```

The domain packages (`domain`, `templates`, `provisioning`) import no cloud SDK and no
framework. Provider code lives only in `cloud-*` packages (spec §3, §42.16).

## From template to cloud

```text
Template (provider-neutral, versioned)
  + variables  ─▶ applyVariables
  + plan       ─▶ plan compatibility (entitlements)
  + bindings   ─▶ placement slot → cloud target + region      (per resource, not per instance)
               ─▶ capability resolution per resource          (adapter catalog, regional gaps)
               ─▶ names, standard tags, resolved spec, spec hash
               ─▶ dependency DAG (explicit + implicit edges)
               ─▶ connectivity strategy per link              (private / peering / TLS+allowlist)
               ─▶ cost estimate (static catalog pricing, "approximate")
               ─▶ policies (public DB, backups, encryption, regions, budget, multi-cloud, …)
= ResolvedInfrastructure ─▶ diff vs known resources ─▶ DeploymentPlan (grouped by provider)
```

Nothing above touches a cloud. A deployment stores the `ResolvedInfrastructure` snapshot so
what was previewed is exactly what is applied.

### Placement slots

A template declares named slots (`primary`, `data`, `storage`) and the providers each slot
accepts. Each instance binds every slot to one of its cloud targets and a region. Binding all
slots to one AWS target gives the single-cloud variant of the same template; binding `data` to
Azure gives a multi-cloud instance. See [ADR 0001](adr/0001-placement-slots.md).

## Deployment workflow

Steps are created when the deployment is requested, so the UI shows the full plan
immediately. The worker runs:

`validate → targets → plan → [approval] → resources (DAG) → rollout → configure → verify →
observability → finalize` (destroy: `validate → backup → plan → resources (reverse DAG) →
cleanup → finalize`).

- Each phase/resource step is persisted before and after it runs. A crashed worker's job is
  re-delivered (BullMQ stalled-job handling) and resumes: finished phases are skipped,
  converged resources (same idempotency key) are not re-run.
- Resource failures skip only dependents; unrelated branches continue (partial failure is a
  first-class outcome). Only transient failure classes are retried, with exponential backoff.
  Destructive operations are never retried automatically.
- Instance status moves through a validated state machine; every transition is recorded.
- Concurrency: one active deployment per instance (atomic compare-and-set on status) and a
  configurable slot limit per cloud target (Redis).

## State: desired, known, actual

The database holds **desired** state (templates, instance config) and **known** state (what we
recorded). Providers hold **actual** state. Every resource row carries a knowledge state
(`DESIRED`, `KNOWN`, `ACTUAL`, `UNKNOWN`) and drift status; the health monitor re-reads actual
state each tick and flags drift.

## Health, status and incidents

The worker's health tick checks every active resource through its adapter, rolls health up to
the instance (critical vs non-critical components), maps resources to customer-facing status
components (API, Workers, Database, …), and evaluates alert rules stored as data. Incidents
are deduplicated per resource, respect a cooldown, and auto-resolve when health returns.
Notifications go to tenant owners/admins and platform admins (in-app + email outbox).

## Security model (summary)

See [SECURITY.md](SECURITY.md). Opaque session tokens (hash stored), CSRF header, CASL on every
loaded record plus query-level tenant scoping, secrets referenced never stored, provider
credentials never reach the browser, append-only audit log enforced by a DB trigger.
