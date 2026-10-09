# ADR 0003: Deployment workflow on BullMQ with persisted steps

**Status:** accepted on October 4, 2026

## Options

1. Temporal: durable workflows out of the box, but it adds a cluster to operate, which is heavy
   for the low cost validation profile (spec §94).
2. BullMQ, with the workflow state persisted in Postgres: it reuses the Redis and Postgres the
   platform already requires.

## Decision

Option 2. Jobs carry only the deployment id. Steps (phases and resources) are rows created when
the deployment is requested, and the worker updates them before and after each action. Resuming
means running the job again: finished phases are skipped, and resources with a matching
idempotency key are not applied again. BullMQ's stalled job detection redelivers work from
crashed workers. Approval parks the deployment; approving it puts it back in the queue.

## Consequences

This is good enough for infrastructure workflows that take minutes and fan out moderately. If
long running flows with people in the loop or very large fan out appear, revisit Temporal; the
step model maps onto it directly.
