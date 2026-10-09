# Roadmap and gap analysis

Status against the specification. **Done** means implemented and verified, **Partial** means
implemented with gaps, **Not started** means nothing exists yet.

## Acceptance criteria (spec §96)

| # | Criterion | Status | Gap |
|---|---|---|---|
| 1 | Sign in with SSO | Partial | OIDC (Entra) is implemented but untested without an app registration. Google and GitLab are configuration only. **GitHub needs an OAuth adapter (it is not OIDC).** |
| 2 | Create and manage a tenant | Done | Member invitations exist in the model only: **no invite and accept flow, no team UI**. |
| 3 | Assign a plan | Done | No UI to edit plans (entitlements). |
| 4 | Connect an AWS account safely | Done | AssumeRole with an external id; secret references `env://` and `aws-sm://` (Secrets Manager). |
| 5 | Validate AWS access | Done | Identity, state bucket and permission simulation per service (`iam:SimulatePrincipalPolicy`); deployment role CloudFormation in `infra/aws/`. |
| 6 | Choose a region | Done | |
| 7 | Choose a default template | Done | |
| 8 | Create a logical instance | Done | |
| 9 | Configure application images | Partial | Catalog with digests (seeded). **Catalog management UI and API, registry sync and a CI hook** are missing. |
| 10 | Review resolved infrastructure | Done | |
| 11 | Run a plan | Done | Platform plan diff plus a real `tofu plan` per resource in the plan phase; destructive changes send production deployments to approval. **The plan diff view in the console** is still text only. |
| 12 | Deploy asynchronously | Done | Real on MiniStack and AWS through OpenTofu, or simulated. |
| 13 | Watch progress | Done | Live steps, Gantt timeline, event log. |
| 14 | See created resources | Done | Topology diagram and list. |
| 15 | See service health | Done | Through the AWS SDK on AWS, simulated elsewhere. |
| 16 | Logs, metrics, traces | Partial | AWS logs through CloudWatch. **Metrics (CloudWatch GetMetricData) and traces (OTel)** are missing for real targets. |
| 17 | Customer status page | Done | Public and subscription visibility modes are missing. |
| 18 | Deployment and incident notifications | Done | Console and email. Webhook, Slack and Teams channels are missing, and so is a preferences UI. |
| 19 | Create and update incidents | Done | Maintenance windows exist in the model only. |
| 20 | Destroy safely | Done | Backup verification is informational, not enforced. |
| 21 | Audit everything | Done | Append only, enforced by the database. Retention policy missing; export is an Enterprise feature. |
| 22 | Modify, clone and create templates | Done | Visual builder and YAML. |
| 23 | Explicit template upgrade | Partial | Version switch and plan work; a **side by side template diff** in the UI is missing. |
| 24 | Run locally without credentials | Done | |
| 25 | Deterministic mock deployment | Done | |

## Multicloud acceptance (spec §43)

| Item | Status | Gap |
|---|---|---|
| Register AWS, Azure and OCI targets | Partial | AWS is real; **Azure and OCI adapters do not exist** (simulated only). |
| Validate all three | Partial | Same. |
| Template with ECS, Azure Postgres and OCI storage | Done | `multicloud-reference`. |
| Cross cloud connectivity | Partial | The strategy is chosen and shown; **no VPN, interconnect or allowlist provisioning** (for example an Azure Postgres firewall rule for the AWS NAT addresses). |
| Topology and cost preview | Done | Static pricing; **pricing API adapters** are missing. |
| Retry only failed resources | Done | |
| Detect drift | Done | Mock: on every health check. AWS: scheduled refresh only plans (attribute level, emulator noise filtered). A redeploy restores drifted resources. |
| Incident on an unhealthy managed dependency | Done | |
| Dependency aware destroy | Done | |

## Platform capabilities still missing

**Cloud providers**

- Azure adapter (Container Apps, PostgreSQL Flexible Server, Blob, Service Bus, App Gateway, DNS)
  with OpenTofu `azurerm` modules and workload identity authentication.
- OCI adapter (Object Storage first) and modules; a GCP adapter later.
- AWS: custom domains (verification and ACM for customer domains), a WAF option, ECS Managed
  Instances.

**Provisioning**

- Production runner isolation: run the OpenTofu container as an ECS RunTask or a Kubernetes Job
  with a scoped role instead of using the worker's Docker socket.
- Backups API: last successful backup, restore to a new instance.
- Import and adoption of existing resources (spec §89).

**Product**

- Team management: invitations, roles per tenant, member removal.
- Application catalog management and the CI/CD intake endpoint (application, version and digest,
  signed webhook).
- Admin UIs for plans and entitlements, feature flags, platform settings and policies.
- Notification preferences UI; webhook, Slack and Teams channels.
- Public status pages and status subscriptions.
- Cost: pricing adapters (AWS Price List API), actual spend (Cost Explorer) compared with the
  estimate.

**Observability of the platform itself**

- OpenTelemetry SDK in the API and the worker (traces and metrics), the §77 metrics, dashboards,
  SLO alerts.

**Quality and operations**

- Playwright end to end tests for the acceptance flow; API integration tests in CI with Postgres
  and Redis.
- A tenant isolation test suite (every endpoint, every role, a foreign tenant).
- Load tests (p95 under 300 ms as the target), dependency and image scanning in CI.
- Deployment of the control plane itself (container images, IaC for OrkStage on AWS), backups,
  disaster recovery runbooks, `OPERATIONS.md` and `RUNBOOKS.md`.
- Postgres row level security as an extra isolation layer.

## Suggested order

1. **Real AWS hardening.** Done: `tofu plan` before apply with approval, permission probing, the
   secret manager resolver, autoscaling, the drift job. Left: the runner as an ECS task, then a
   test against a real sandbox account.
2. **Azure adapter** (the second provider in the specification), including cross cloud
   allowlisting.
3. **Product completeness:** teams and invitations, catalog and CI intake, preferences.
4. **Platform operations:** OpenTelemetry, end to end, isolation and load tests in CI,
   deployment of the control plane.
5. OCI and GCP, public status pages, FinOps, import and adoption.
