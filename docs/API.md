# Control API (v1)

Base path: `/api/v1`. The OpenAPI UI is served at `/api/docs` while the API runs. Request
bodies and response shapes are defined in [`packages/contracts`](../packages/contracts/src): that
package is the source of truth, and this page is the map.

## Conventions

- **Auth:** an opaque session token in the `orkstage_session` cookie (`httpOnly`, `SameSite=Lax`), or
  an API key (see [Integrations](#integrations-api-keys-webhooks-ci-imports)).
- **CSRF:** every `POST`, `PATCH`, `PUT` and `DELETE` made with a session must send
  `x-orkstage-csrf: 1`. Browsers cannot add custom headers on another site's behalf without a CORS
  preflight, and the API does not grant one to other origins.
- **Correlation:** send `x-correlation-id` to correlate requests; the API returns
  `x-correlation-id` and `x-request-id` on every response.
- **Idempotency:** deployments are keyed by tenant, instance and the hash of the desired state.
  While an instance has an active operation, further deploy or destroy requests get
  `409 INSTANCE_BUSY`, and the worker never creates converged resources again. An
  `Idempotency-Key` header is accepted and currently ignored.
- **Pagination:** `?limit=25&cursor=<id>` returns `{ items, nextCursor }`, newest first.
- **Errors:** `{ "error": { code, message, requestId, correlationId, details } }`. No stack traces.
- **Tenancy:** every read of tenant owned data is filtered by the caller's memberships, and
  every write is checked with CASL on the loaded record. Tenant ids in requests are never trusted
  on their own.
- **Long operations** (deploy, destroy) return `202` with a deployment; read progress from the
  deployment endpoints. Nothing long running happens inside a request.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz`, `/readyz` | liveness and readiness (database and Redis) |
| POST | `/auth/dev-login` `{email}` | local development only; disabled in production |
| GET | `/auth/providers` | enabled SSO providers `[{key,name}]` |
| GET | `/auth/oidc/:provider/login?returnTo=/path` | redirects to the identity provider (state, nonce, PKCE) |
| GET | `/auth/oidc/:provider/callback` | validates, creates the session, redirects to the console |
| POST | `/auth/logout` | revokes the session |
| GET | `/me` | `MeResponse`, including the CASL rules |
| GET | `/overview` | `OverviewDto` (platform staff) |
| GET | `/overview/trends` | deployment and health series for the dashboard charts |
| GET | `/plans` | `PlanDto[]` |
| GET/POST | `/tenants` | list (scoped) or create (platform admin) |
| GET/PATCH | `/tenants/:id` | |
| GET | `/templates` | `TemplateDto[]` with the latest published version |
| POST | `/templates` `{source}` | new template, first version as DRAFT |
| GET | `/templates/:id` | includes `versions` |
| POST | `/templates/:id/versions` `{source}` | new DRAFT version (published versions are immutable) |
| POST | `/templates/:id/validate` `{source?, planCode?}` | validation report |
| POST | `/templates/:id/versions/:versionId/publish` | runs the full validation; refuses unsafe templates |
| POST | `/templates/:id/clone` `{name, displayName}` | |
| GET | `/applications` | `ApplicationDto[]` (image catalog) |
| GET | `/cloud/providers` | providers with an installed adapter |
| GET/POST | `/cloud/targets` | `CloudTargetDto[]` or register a target |
| POST | `/cloud/targets/:id/validate` `{region?}` | runs the adapter validation and stores the result |
| GET | `/cloud/targets/:id/capabilities` | `CapabilityDto[]` |
| GET/POST | `/instances` | list (`?tenantId`) or create a DRAFT |
| GET/PATCH | `/instances/:id` | `InstanceDto` with resources and the last deployment |
| POST | `/instances/:id/preview` | `PreviewDto`: compile, policies, cost and plan, without changes |
| POST | `/instances/:id/deploy` | `202 DeploymentSummaryDto` |
| POST | `/instances/:id/upgrade` `{templateVersionId}` | explicit template version change (deploy afterwards) |
| POST | `/instances/:id/destroy` `{confirm: slug}` | `202 DeploymentSummaryDto` |
| GET | `/instances/:id/deployments` | `Page<DeploymentSummaryDto>` |
| GET | `/instances/:id/logs?resourceId=&limit=` | log lines (simulated for mock targets) |
| GET | `/instances/:id/metrics?resourceId=&metric=cpu&minutes=60` | data points |
| POST | `/instances/:id/simulate` `{resourceId, health?, drift?}` | mock targets only |
| GET | `/deployments` | `Page<DeploymentSummaryDto>` |
| GET | `/deployments/:id` | `DeploymentDto` with steps, plan and cost |
| GET | `/deployments/:id/events?after=<id>` | `DeploymentEventDto[]` (poll every 1 to 2 seconds) |
| POST | `/deployments/:id/approve` | approval gate |
| POST | `/deployments/:id/cancel` | cooperative cancel |
| POST | `/deployments/:id/retry` | runs only the failed and skipped resources again |
| GET/POST | `/incidents` | list (`?tenantId&status`) or create one manually |
| GET | `/incidents/:id` | includes updates |
| POST | `/incidents/:id/updates` `{status, message, impact?}` | |
| GET | `/status/:tenantId` | `StatusPageDto` (private customer status page) |
| GET | `/notifications` | the current user's notifications |
| POST | `/notifications/:id/read` | |
| GET | `/audit` | `Page<AuditEventDto>` (`?tenantId`) |

### Integrations (API keys, webhooks, CI, imports)

Authenticate with a session cookie or `Authorization: Bearer ork_<env>_<id>_<secret>`. Every
route requires an explicit key scope. Full contract: [`specs/integration-api.md`](specs/integration-api.md).

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/api-keys` | list (`?tenantId`) or create; the secret is returned once |
| DELETE | `/api-keys/:id` | revoke |
| GET/POST | `/webhooks` | list or create (the secret is returned once) |
| PATCH/DELETE | `/webhooks/:id` | update or delete |
| POST | `/webhooks/:id/rotate-secret` | new signing secret |
| POST | `/webhooks/:id/test` | sends a `ping` delivery |
| GET | `/webhooks/:id/deliveries` | delivery log |
| POST | `/webhooks/:id/deliveries/:deliveryId/redeliver` | |
| POST | `/templates/validate` `{source, planCode?}` | stateless validation (CI) |
| PUT | `/applications/:name` | create or update a catalog application (CI) |
| POST | `/applications/:name/versions` | publish an immutable image digest (CI) |
| POST | `/imports` `{report}` or `{files}` | a ScanReport v1 from `ork import`, or files scanned on the server |
| GET | `/imports`, `/imports/:id` | |
| POST | `/imports/:id/template` `{name, displayName}` | draft template from an import |

### Licensing and Enterprise

| Method | Path | Notes |
|---|---|---|
| GET | `/license` | edition, features, expiry and grace period |
| GET | `/audit/export?format=csv\|ndjson` | Enterprise (`402 ENTERPRISE_REQUIRED` otherwise); streamed |

The OpenAPI document is served at `/api/docs-json`, and the Swagger UI at `/api/docs`.
