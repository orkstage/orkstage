# Control API (v1)

Base path: `/api/v1`. OpenAPI UI at `/api/docs` when the API runs. Request bodies and response
shapes are defined in [`packages/contracts`](../packages/contracts/src) — that package is the
source of truth; this page is the map.

## Conventions

- **Auth:** opaque session token in the `co_session` httpOnly, `SameSite=Lax` cookie.
- **CSRF:** every `POST`/`PATCH`/`PUT`/`DELETE` must send `x-co-csrf: 1`. Browsers cannot add
  custom headers cross-site without a CORS preflight, which the API does not grant to other origins.
- **Correlation:** send `x-correlation-id` to correlate; the API returns `x-correlation-id` and
  `x-request-id` on every response.
- **Idempotency:** deploys are keyed by `tenant + instance + desired-state hash`. While an
  instance has an active operation, further deploy/destroy requests get `409 INSTANCE_BUSY`; the
  worker never re-creates converged resources. (An `Idempotency-Key` header is accepted and
  currently ignored.)
- **Pagination:** `?limit=25&cursor=<id>` → `{ items, nextCursor }` (newest first).
- **Errors:** `{ "error": { code, message, requestId, correlationId, details } }`. No stack traces.
- **Tenancy:** every tenant-owned read is filtered by the caller's memberships, and every write
  is checked with CASL on the loaded record. Tenant ids in requests are never trusted on their own.
- **Long operations** (deploy, destroy) return `202` with a deployment; progress is read from
  the deployment endpoints. Nothing long-running happens inside a request.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz`, `/readyz` | liveness / readiness (DB + Redis) |
| POST | `/auth/dev-login` `{email}` | local only; disabled in production |
| GET | `/auth/providers` | enabled SSO providers `[{key,name}]` |
| GET | `/auth/oidc/:provider/login?returnTo=/path` | redirects to the IdP (state + nonce + PKCE) |
| GET | `/auth/oidc/:provider/callback` | validates and creates the session, redirects to web |
| POST | `/auth/logout` | revokes the session |
| GET | `/me` | `MeResponse` incl. CASL rules |
| GET | `/overview` | `OverviewDto` (platform staff) |
| GET | `/plans` | `PlanDto[]` |
| GET/POST | `/tenants` | list (scoped) / create (platform admin) |
| GET/PATCH | `/tenants/:id` | |
| GET | `/templates` | `TemplateDto[]` with latest published version |
| POST | `/templates` `{source}` | new template as DRAFT 1st version |
| GET | `/templates/:id` | incl. `versions` |
| POST | `/templates/:id/versions` `{source}` | new DRAFT version (published versions are immutable) |
| POST | `/templates/:id/validate` `{source?, planCode?}` | validation report |
| POST | `/templates/:id/versions/:versionId/publish` | runs full validation; refuses unsafe templates |
| POST | `/templates/:id/clone` `{name, displayName}` | |
| GET | `/applications` | `ApplicationDto[]` (image catalog) |
| GET | `/cloud/providers` | providers with an installed adapter |
| GET/POST | `/cloud/targets` | `CloudTargetDto[]` / register a target |
| POST | `/cloud/targets/:id/validate` `{region?}` | runs adapter validation, persists result |
| GET | `/cloud/targets/:id/capabilities` | `CapabilityDto[]` |
| GET/POST | `/instances` | list (`?tenantId`) / create DRAFT |
| GET/PATCH | `/instances/:id` | `InstanceDto` incl. resources + last deployment |
| POST | `/instances/:id/preview` | `PreviewDto`: compile + policy + cost + plan, no mutation |
| POST | `/instances/:id/deploy` | `202 DeploymentSummaryDto` |
| POST | `/instances/:id/upgrade` `{templateVersionId}` | explicit template version change (then deploy) |
| POST | `/instances/:id/destroy` `{confirm: slug}` | `202 DeploymentSummaryDto` |
| GET | `/instances/:id/deployments` | `Page<DeploymentSummaryDto>` |
| GET | `/instances/:id/logs?resourceId=&limit=` | log lines (simulated for mock targets) |
| GET | `/instances/:id/metrics?resourceId=&metric=cpu&minutes=60` | points |
| POST | `/instances/:id/simulate` `{resourceId, health?, drift?}` | mock targets only |
| GET | `/deployments` | `Page<DeploymentSummaryDto>` |
| GET | `/deployments/:id` | `DeploymentDto` with steps, plan, cost |
| GET | `/deployments/:id/events?after=<id>` | `DeploymentEventDto[]` (poll every 1–2 s) |
| POST | `/deployments/:id/approve` | approval gate |
| POST | `/deployments/:id/cancel` | cooperative cancel |
| POST | `/deployments/:id/retry` | re-runs only failed/skipped resources |
| GET/POST | `/incidents` | list (`?tenantId&status`) / create manual |
| GET | `/incidents/:id` | incl. updates |
| POST | `/incidents/:id/updates` `{status, message, impact?}` | |
| GET | `/status/:tenantId` | `StatusPageDto` (customer private status page) |
| GET | `/notifications` | current user's in-app notifications |
| POST | `/notifications/:id/read` | |
| GET | `/audit` | `Page<AuditEventDto>` (`?tenantId`) |
