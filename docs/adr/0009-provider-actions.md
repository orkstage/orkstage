# ADR 0009: Provider actions as one catalog for triggers and future agents

**Status:** accepted on October 23, 2026 (owner decision; orkstage-dev `docs/aws-items.md`, A8).
Round 1 built: the catalog (`packages/domain/src/actions.ts`), resolution and roles for triggers,
and the AWS operations. Round 2 built (October 24): release settings, bake periods, smart and
manual rollback, canary and blue/green through the adapter contract (the simulator implements
them; AWS offers them after the first real account run, A1), and production approval for
disruptive trigger runs. See "As built" at the end.

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

## As built (round 2)

- **Release settings** come from the template (`spec.release`: `strategy` rolling, canary or
  blueGreen; `trafficPercent`; `bakeMinutes`; `autoRollback`) with the deploy call's own on top,
  and are stored on the deployment. A canary or blue/green release without a bake period gets 15
  minutes.
- **Bake period.** After a successful apply with `bakeMinutes`, the worker watches the instance on
  every health tick. An automated incident on the instance, or a critical resource failing three
  checks in a row, fails the bake; a period that passes marks the deployment verified and, for a
  canary or blue/green release, calls the adapter's `promoteRelease`. An apply without a bake
  period is verified when it finishes healthy. A watched release that fails its health checks in
  the verify phase is rolled back right away, so a bad canary never keeps its share of traffic.
- **Smart rollback** is an apply of the target deployment's frozen configuration (template
  version, image digests, variables), marked with `rollbackToId`. The automatic one targets the
  last verified deployment before the failed one; `POST /instances/:id/rollback` and the
  `release.rollback` trigger take a deployment id or default to the last verified one. Production
  rollbacks follow the plan approval rule like any apply.
- **Canary and blue/green** reach adapters as `release` on the container service request; adapters
  declare `releaseStrategies` and implement `promoteRelease`. A deploy that asks for a strategy a
  provider does not offer is refused (`RELEASE_STRATEGY_UNSUPPORTED`). The simulator implements
  both as traffic weights, and `unhealthyImages` on a simulated target makes a release fail its
  checks. AWS declares none yet: the ECS deployment controller strategies come with A1.
- **Platform actions.** `release.canary`, `release.blueGreen` and `release.rollback` are run by the
  API as deployments (`platform: true` in the catalog), never on a schedule
  (`TRIGGER_NOT_SCHEDULABLE`). Providers with their own rollback (Render, Vercel) keep it.
- **Production approval.** A trigger run of a disruptive or destructive action on a production
  instance waits in `AWAITING_APPROVAL`, scheduled ones too, and notifies
  `trigger.awaiting_approval`; an approver with the approval permission and the action's role runs
  it, anyone allowed to deploy can cancel it.
