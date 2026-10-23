# ADR 0009: Provider actions as one catalog for triggers and future agents

**Status:** accepted on October 23, 2026 (owner decision; orkstage-dev `docs/aws-items.md`, A8).
Not built yet.

## Context

Template triggers run provider actions through `runAction` and the adapter's action descriptors
(`ResourceActionDescriptor` in `packages/cloud-core`). Each adapter names its own actions. On AWS
the only action is the database restore added for backups (open item 18), so triggers on AWS can
otherwise only deploy.

The AI mini agents planned in open item 29 will need a vocabulary of things they can propose
("restart the API", "roll back to the last healthy release"). If every adapter keeps its own
names, neither templates nor agents can be written once for every cloud.

## Decision

1. **A provider neutral action catalog** in `packages/domain`. Each action has a stable id, a
   description, typed parameters, the resource types it applies to, a **risk level** (`safe`,
   `disruptive` or `destructive`), whether it can be undone, and a minimum role. Adapters declare
   which catalog actions they implement; provider specific actions stay possible but are named
   `<provider>.<action>` and are not offered to agents.
2. **Operations first.** The initial set, AWS first:
   - `service.restart`: start fresh tasks with the same release (ECS force new deployment).
   - `service.scale`: set the desired count, within the template's autoscaling bounds and the
     tenant limits.
   - `cdn.invalidate`: invalidate paths on the CDN (CloudFront).
   - `database.reboot` and `database.snapshot` (RDS), next to the existing restore.
3. **Release strategies.** Actions that change how a release reaches traffic:
   - `release.canary`: send a small share of traffic to the new release, watch it for a bake
     period, then promote it or roll it back.
   - `release.blueGreen`: bring the new release up beside the old one, switch traffic after its
     health checks pass, keep the old one for the bake period.
   - `release.rollback`: return to a chosen earlier deployment.
   The cloud's own mechanism is preferred over steering traffic from the worker: on AWS, the ECS
   deployment controller's blue/green and canary strategies with alarm based rollback, verified in
   the first real account run (A1) before they are offered.
4. **Smart rollback.** During a canary or blue/green bake period, a breached metric alert rule
   (open item 7) or failed health checks roll the release back automatically. A manual
   `release.rollback` without a target picks the last deployment that stayed healthy for its whole
   bake period. A rollback redeploys that deployment's frozen template version and image digests;
   it never reverts OpenTofu state by hand, and the plan warns that database migrations are not
   undone.
5. **Who may run what.** `safe` actions need `CustomerDeveloper`; `disruptive` and `destructive`
   actions need `CustomerAdmin` by default, and in production they follow the same approval rule as
   deployments. A template may raise an action's role, never lower it. Every run is audited and
   carries an idempotency key.
6. **Agents propose, people run.** The catalog is the only set of actions an agent may suggest.
   An agent's suggestion shows the action, its parameters and its risk level, and a person with the
   required role runs it. Agents never run actions themselves (open item 29 keeps agents read only).

## Consequences

- Templates and agents describe operations once for every cloud; adapters map catalog ids to their
  provider calls.
- Release strategies need infrastructure shaped for them (two target groups, alarms); the AWS
  module gains the parts they need, off unless a template asks for a strategy.
- The trigger schema keeps accepting existing action names; adapters map them to catalog ids during
  a deprecation period.
