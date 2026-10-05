# ADR 0003 — Deployment workflow on BullMQ with persisted steps

**Status:** accepted (2026-10-04)

## Options

1. Temporal — durable workflows out of the box; adds a cluster to operate (heavy for the
   low-cost validation profile, spec §94).
2. BullMQ + workflow state persisted in Postgres — reuses Redis/Postgres already required.

## Decision

Option 2. Jobs carry only the deployment id. Steps (phases and resources) are rows created at
request time; the worker updates them before/after each action. Resume = re-run the job:
finished phases are skipped and resources with a matching idempotency key are not re-applied.
BullMQ stalled-job detection re-delivers work from crashed workers. Approval parks the
deployment; approving re-enqueues it.

## Consequences

Good enough for minutes-long infrastructure workflows with modest fan-out. If long-running
human-in-the-loop flows or very large fan-out appear, revisit Temporal; the step model maps
onto it directly.
