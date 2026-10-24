# Runbooks

What to do when something goes wrong with a running OrkStage control plane. Each runbook says how
to recognise the problem, what to check, and how to fix it. Local setup problems (ports, MiniStack,
first start) are in the site's troubleshooting page; recovery objectives and backups are in
[docs/DATABASE.md](DATABASE.md) and the site's disaster recovery page.

Commands assume the production Compose file (`deploy/compose.yaml`, services `api`, `worker`, `web`,
`migrate`, `postgres`, `redis`); adapt them to your orchestrator.

## The API is not ready

**Signs.** `GET /api/v1/readyz` fails, the console shows "Cannot reach the control API".

1. `docker compose logs --tail 100 api`. A configuration error lists every invalid variable at
   startup ("Invalid configuration"); fix them and restart.
2. Postgres or Redis unreachable: check `DATABASE_URL` and `REDIS_URL`, and that both services are
   healthy.
3. Pending migrations: the `migrate` service runs `pnpm db:deploy && pnpm db:seed` before the API
   starts. Run it again (`docker compose run --rm migrate`) and read its output.

## Deployments stay queued

**Signs.** New deployments stay `QUEUED`; trigger runs and notifications do not move either.

1. `docker compose logs --tail 100 worker`: the worker logs `worker started` and then its jobs.
2. Redis: the queues are `deployments`, `health-checks`, `notifications`, `drift-scans`,
   `triggers` and `emails`. A worker connected to another Redis (or another database index) never
   sees them.
3. **Stray workers.** Every worker on the same Redis takes jobs from the same queues. A forgotten
   worker (an old container, a developer's host process pointed at production Redis) takes jobs and
   runs them with its own code and configuration. Make sure only the intended workers run.
4. Restart the worker. Jobs carry ids only and the worker reloads state from Postgres, so a restart
   loses nothing.

## A deployment is stuck running

**Signs.** A deployment shows `RUNNING` with no new events; the instance answers `409 INSTANCE_BUSY`
to new deploys.

1. Wait for the reaper: after `TOFU_TIMEOUT_MINUTES + 15` minutes (60 by default) without a live
   job or a new event, the worker's housekeeping fails the deployment and frees the instance.
2. Or cancel it: **Cancel** on the deployment page, or `POST /api/v1/deployments/<id>/cancel`.
3. Then **Retry** (`POST /api/v1/deployments/<id>/retry`): resources that converged are not
   applied again.

## A deployment waits for approval

**Signs.** `AWAITING_APPROVAL`. Production changes that delete, replace or touch a database stop
here. Someone with the approval permission reviews the plan and approves it
(`POST /api/v1/deployments/<id>/approve`) or cancels it. Nothing happens until then.

## OpenTofu reports a state lock

**Signs.** A resource fails with "Error acquiring the state lock"; the error names the work
directory.

A run that died while holding the lock leaves it behind. Make sure no other run of that resource is
in progress, then release it from a runner container with the target's credentials:
`tofu force-unlock <lock id>` in the named work directory (the site's OpenTofu page has the full
command). Retry the deployment afterwards.

## A retry answers 409 IDEMPOTENCY_IN_PROGRESS

The first request with that `Idempotency-Key` is still running, or died without answering. A
running claim expires after 5 minutes; retry after that, or send a new key if the first request
certainly did not happen.

## Cost estimates use the bundled tables instead of live prices

**Signs.** Plan lines name the bundled AWS list prices as their source instead of the AWS pricing API.

The API could not read the AWS Pricing API (most often the target role lacks
`pricing:GetProducts`, see the role template) and remembers that for an hour. Fix the role, then
delete the marker so the next plan asks again: `redis-cli DEL prices:aws:<region>`. Live prices
are kept a day under the same key.

## A database backup failed

**Signs.** A `backup.failed` notification; the database card shows the problem.

1. Read the message on the card (it comes from the provider) and check the database in the
   provider's console.
2. Until a backup succeeds, a destroy of a production instance is refused with
   `BACKUP_NOT_RECENT`. Take one with a `database.snapshot` trigger, or confirm the destroy without
   a recent backup only if losing the data is acceptable.

## Drift was detected

**Signs.** `instance.drift_detected`; resources show `DRIFT_DETECTED` with the planned changes.

Someone changed a resource outside OrkStage. Deploy the instance to put it back the way the template
says, or change the template if the manual change should stay.

## Rotate platform secrets

- **`SESSION_SECRET`:** set the new value and restart the API; everyone signs in again.
- **`ENCRYPTION_KEY`:** stored webhook signing secrets become unreadable. Rotate every webhook's
  secret after the change, and update the receivers.
- **Target credentials:** follow the provider's page (for AWS, update the role stack's
  `ExternalId`, then the secret the target references, then **Validate** the target). Only the new
  value works from then on.

## The control plane database is lost

Restore it from your backups as described in [docs/DATABASE.md](DATABASE.md) and the site's
disaster recovery page: restore Postgres, start the API and the worker with the same
`ENCRYPTION_KEY` and `SESSION_SECRET`, and let health checks and drift scans read the actual state of
every resource again. Cloud resources are not touched while the control plane is down.

## Redis is lost

Restart Redis (with `appendonly yes`, queues and rate limit counters survive restarts). Without
persistence, queued jobs are gone: deployments that were running are failed by the reaper and can
be retried; scheduled jobs (health ticks, drift scans, scheduled triggers) are registered again
when the worker starts.
