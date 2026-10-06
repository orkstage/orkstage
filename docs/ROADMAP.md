# Roadmap and gap analysis

Status against the spec. ✅ done and verified · 🟡 partial · ⬜ not started.

## Acceptance criteria (spec §96)

| # | Criterion | Status | Gap |
|---|---|---|---|
| 1 | Sign in with SSO | 🟡 | OIDC (Entra) implemented, untested without an app registration. Google/GitLab = config; **GitHub needs an OAuth (non-OIDC) adapter**. |
| 2 | Create/manage a tenant | ✅ | Member invitations: model only, **no invite/accept flow or team UI**. |
| 3 | Assign a plan | ✅ | Plan editing UI (entitlements) missing. |
| 4 | Connect an AWS account safely | ✅ | AssumeRole + external id; secret references `env://` and `aws-sm://` (Secrets Manager). |
| 5 | Validate AWS access | ✅ | Identity, state bucket and per-service permission simulation (`iam:SimulatePrincipalPolicy`); deployment-role CloudFormation in `infra/aws/`. |
| 6 | Choose a region | ✅ | |
| 7 | Choose a default template | ✅ | |
| 8 | Create a logical instance | ✅ | |
| 9 | Configure application images | 🟡 | Catalog with digests (seeded). **Catalog CRUD UI/API, registry sync, CI hook** missing. |
| 10 | Review resolved infrastructure | ✅ | |
| 11 | Run a plan | ✅ | Platform plan diff + real per-resource `tofu plan` in the plan phase; destructive changes escalate production deployments to approval. **Plan diff view in the console** still text-only. |
| 12 | Deploy asynchronously | ✅ | Real on MiniStack/AWS via OpenTofu, or simulated. |
| 13 | Watch progress | ✅ | Live steps, Gantt timeline, event log. |
| 14 | See created resources | ✅ | Topology diagram + list. |
| 15 | See service health | ✅ | SDK-based on AWS, simulated elsewhere. |
| 16 | Logs/metrics/traces | 🟡 | AWS logs via CloudWatch; **metrics (CloudWatch GetMetricData) and traces (OTel) missing** for real targets. |
| 17 | Customer status page | ✅ | Public/subscription visibility modes missing. |
| 18 | Deployment/incident notifications | ✅ | In-app + email. Webhook/Slack/Teams channels missing; preferences UI missing. |
| 19 | Create/update incidents | ✅ | Maintenance windows: model only. |
| 20 | Destroy safely | ✅ | Backup verification is informational, not enforced. |
| 21 | Audit everything | ✅ | DB-enforced append-only. Export/retention policy missing. |
| 22 | Modify/clone/create templates | ✅ | Visual builder + YAML. |
| 23 | Explicit template upgrade | 🟡 | Version switch + plan ✅; **side-by-side template diff** in UI missing. |
| 24 | Run locally without credentials | ✅ | |
| 25 | Deterministic mock deployment | ✅ | |

## True multi-cloud acceptance (spec §43)

| Item | Status | Gap |
|---|---|---|
| Register AWS / Azure / OCI targets | 🟡 | AWS real; **Azure and OCI adapters do not exist** (simulated only). |
| Validate all three | 🟡 | Same. |
| Template with ECS + Azure PG + OCI storage | ✅ | `multicloud-reference`. |
| Cross-cloud connectivity | 🟡 | Strategy chosen + surfaced; **no VPN/interconnect or allowlist provisioning** (e.g. Azure PG firewall rule from AWS NAT IPs). |
| Topology and cost preview | ✅ | Static pricing; **pricing API adapters** missing. |
| Retry only failed resources | ✅ | |
| Detect drift | ✅ | Mock per health check; AWS via scheduled refresh-only plans (attribute-level, emulator noise filtered); redeploy restores drifted resources. |
| Incident on unhealthy managed dependency | ✅ | |
| Dependency-aware destroy | ✅ | |

## Platform capabilities still missing

**Cloud providers**
- Azure adapter (Container Apps, PostgreSQL Flexible Server, Blob, Service Bus, App Gateway, DNS) + OpenTofu `azurerm` modules + workload-identity auth.
- OCI adapter (Object Storage first) + modules; GCP adapter later.
- AWS: custom domains (verification + ACM for customer domains), WAF option, ECS Managed Instances.

**Provisioning**
- Production runner isolation: run the OpenTofu container as an ECS RunTask / Kubernetes Job with a scoped role instead of the worker's Docker socket.
- Backups API: last successful backup, restore to a new instance.
- Brownfield import/adoption (spec §89).

**Product**
- Team management: invitations, roles per tenant, member removal.
- Application catalog management + CI/CD intake endpoint (`application + version + digest`, signed webhook).
- Plan/entitlement admin UI, feature-flag admin, platform settings UI, policy configuration UI.
- Notification preferences UI; webhook/Slack/Teams channels.
- Public status pages and status subscriptions.
- Cost: pricing adapters (AWS Price List API), actual-spend (Cost Explorer) vs estimate.

**Observability of the platform itself**
- OpenTelemetry SDK in API/worker (traces + metrics), the §77 metrics, dashboards, SLO alerts.

**Quality and operations**
- Playwright E2E for the acceptance flow; API integration tests in CI with Postgres/Redis.
- Tenant-isolation test suite (every endpoint × role × foreign tenant).
- Load tests (p95 < 300 ms target), dependency/image scanning in CI.
- Deployment of the control plane itself (container images, IaC for OrkStage on AWS), backups
  and DR runbooks, `OPERATIONS.md` / `RUNBOOKS.md`.
- Postgres row-level security as an extra isolation layer.

## Suggested order

1. **Real AWS hardening:** ~~tofu plan before apply + approval~~, ~~permission probing~~,
   ~~secret-manager resolver~~, ~~autoscaling~~, runner as ECS task, ~~drift job~~. Then test against a
   real sandbox account.
2. **Azure adapter** (the spec's second provider) incl. cross-cloud allowlisting.
3. **Product completeness:** teams/invitations, catalog + CI intake, preferences.
4. **Platform ops:** OTel, E2E/isolation/load tests in CI, control-plane deployment.
5. OCI/GCP, public status pages, FinOps, import/adoption.
