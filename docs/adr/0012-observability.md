# ADR 0012: Observability of the control plane

**Status:** accepted on October 23, 2026. Records the design built for orkstage-dev
`docs/open-items.md` item 6 (item 28 asked for this record).

## Context

Operators run the API and the worker next to their own monitoring stack, which differs from one
installation to the next. They need to follow one operation across the API, the queues, OpenTofu
runs and provider calls, and to alert on the platform's own health. Customers' workloads are a
separate concern: their logs and metrics belong to their cloud accounts.

## Decision

1. **Logs are JSON on stdout.** Pino with a shared configuration (`packages/runtime/src/logger.ts`):
   ISO time, upper case level, a `service` field, and redaction of passwords, secrets, tokens,
   credentials, private keys, cookies and authorization headers. Pretty printing only in
   development. Shipping logs is the platform's job (Docker, Kubernetes, a log agent).

2. **One correlation id per operation.** The API accepts a well formed `x-correlation-id` or uses
   the request id, returns both on every response and in every error body, and logs it on every
   request line. Deployments and trigger runs store it, so the worker, the OpenTofu runs, provider
   calls and audit events carry the id of the request that started them. Work the worker starts
   itself gets its own id (`health-<uuid>`, `drift-<uuid>`, `backup-<uuid>` and so on).

3. **OpenTelemetry, off until configured.** With `OTEL_EXPORTER_OTLP_ENDPOINT` set, the API and the
   worker export traces and metrics over OTLP/HTTP (`packages/runtime/src/telemetry.ts`) as
   `orkstage-api` and `orkstage-worker`. Without it nothing is loaded. HTTP, fetch, ioredis and
   Prisma are instrumented; probes are not traced. Any OTLP backend works; the development stack
   ships a collector, Jaeger and a Prometheus scrape endpoint (`pnpm platform:observe` in
   orkstage-dev).

4. **Traces cross the queues.** Producers put the W3C trace context in the job (`_trace`), and every
   consumer runs inside a `job <queue>` span continued from it, so a deployment's trace starts at
   the HTTP request. Jobs the worker schedules itself start new traces.

5. **A small set of platform metrics** (meter `orkstage`): job duration and retries per queue,
   deployment duration per kind and outcome, provider request duration and errors per provider and
   failure class, incidents opened and time to resolve, notification failures per channel, health
   checks per provider and state, and queue depth per queue and state. Labels never carry tenant or
   instance ids, so cardinality stays bounded.

6. **Health endpoints for orchestrators.** `GET /api/v1/healthz` is liveness; `GET /api/v1/readyz`
   checks Postgres and Redis and answers 503 when either fails. The worker has no HTTP server: it
   is restarted by the orchestrator, and BullMQ hands stalled jobs to another worker.

7. **The audit log is not a log stream.** Who did what lives in `AuditEvent` (append only, read
   through `GET /api/v1/audit`); deployment progress lives in `DeploymentEvent`. Neither depends on
   the log pipeline.

8. **Workload telemetry stays in the provider.** Customer logs and metrics are read on demand
   through the adapter (`getLogs`, `getMetric`) and never stored; metric alert rules read the same
   source. They reach platform telemetry only as health check and incident counts.

9. **Service level objectives are guidance.** The self hosting observability page lists targets
   (API availability, latency, deployment success, notification delivery); SLO management is an
   Enterprise item.

## Consequences

- An installation without a collector loses nothing but traces and metrics; logs, the audit log
  and deployment events keep working.
- Known gaps: provider metrics are recorded for applies only, not destroys; OTLP logs are not
  exported; the worker's log `service` (`provisioning-worker`) differs from its telemetry name;
  notifications and webhook deliveries do not carry the correlation id. Each is small and
  independent.
