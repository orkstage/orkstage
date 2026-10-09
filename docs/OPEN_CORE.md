# OrkStage open core: Community and Enterprise

**Model:** an AGPL-3.0 core plus commercial Enterprise features in `ee/` directories, the model
used by Formbricks, Cal.com and other projects. Decided on October 5, 2026. This document is the plan;
legal texts marked *draft* need review by counsel before any public release.

## 1. Principles

1. **The core is complete.** A team can run Community on its own infrastructure and operate
   production workloads on AWS: templates, multicloud placement, plans, policies and cost,
   deployments, health, incidents, status pages, notifications, audit log, API keys, webhooks,
   the CLI and IaC import. Enterprise adds *organizational scale and compliance*, not basic
   usefulness.
2. **One codebase, one build.** Enterprise code ships in the same images under `ee/` and is
   activated by a signed license key. No separate fork, no feature drift.
3. **Clear boundary.** Everything outside `ee/` is AGPL-3.0. Code inside `ee/` is under the
   OrkStage Enterprise License (the source is available; commercial use requires a
   subscription). Core code never imports from `ee/`; `ee/` plugs into the core through
   extension points.
4. **No dark patterns.** Community never needs to contact our servers; license checks are
   offline (signature verification). Usage telemetry, if it is ever added, will be opt in.

## 2. Feature split

| Area | Community (AGPL) | Enterprise (`ee/`) |
|---|---|---|
| Provisioning | Templates, visual builder, AWS through OpenTofu, mock provider, DAG, retries, drift detection | Policy packs (rule sets in the style of CIS and SOC 2), custom policy authoring, cost budgets per team |
| Multicloud | Placement per resource, cross cloud strategy | Azure, OCI and GCP adapters: **to be decided**. The recommendation is Community, to drive adoption; revisit when the adapters exist |
| Governance | 7 built in roles, approvals for high risk production changes, audit log | Custom roles and fine grained permissions, multistep approval workflows, change windows, **audit export** (JSON or CSV, SIEM streaming) and retention policies |
| Identity | Development login, OIDC (Entra, Google, GitLab through configuration) | SAML 2.0 SSO, SCIM provisioning, enforced SSO and MFA policies, session policies |
| Organizations | One organization, many tenants | Multiple organizations, delegated administration, white label status pages with custom domains |
| Integrations | API keys, webhooks, CI intake, CLI, IaC import | Provisioning of private connectivity (VPN, interconnect), ServiceNow and Jira change management, PagerDuty and Opsgenie |
| Observability | Health, incidents, status pages, logs and metrics through adapters | Long term metrics retention, SLO management, advanced incident analytics |
| Support | Community support in GitHub Discussions | Support backed by an SLA, security advisories before public disclosure |

The first Enterprise module is **audit export** (`ee/`). It proves the boundary, the license
gating and the packaging end to end.

## 3. Licensing mechanics

- **License key:** a compact signed token, `orkstage-license.v1.<payload>.<signature>`. The
  payload is JSON `{ id, customer, edition, features[], seats?, issuedAt, expiresAt }`, signed
  with **Ed25519**. The platform embeds only the public key (`packages/licensing`) and verifies
  keys offline. Configure it with `ORKSTAGE_LICENSE_KEY`.
- **Behavior:** an invalid or missing key means Community. After a key expires there is a 14 day
  grace period with a banner; then Enterprise features switch off. Data is never deleted or
  locked.
- **Gating:** `licensing.has('audit.export')` on the server. The console reads `GET /license`
  only to decide what to show. Gated endpoints return `402 ENTERPRISE_REQUIRED`.
- **Key issuance:** a private signing tool in a separate private repository
  (`orkstage-licensing`), never in the public repositories.

## 4. Repository layout (polyrepo)

```text
orkstage            AGPL core (api, worker, packages) + ee/            public
orkstage-console    AGPL console + ee/ (console screens for EE)        public
orkstage-cli        AGPL (ork CLI + scan engine)                       public
orkstage-modules    Apache-2.0 (reusable OpenTofu modules)             public
orkstage-site       site + docs (code MIT, content CC BY 4.0)          public
orkstage-dev        meta repository: submodules + compose (MIT)        public
orkstage-licensing  license signing service and keys                  private
```

The OpenTofu modules use Apache-2.0 so that users can copy them into their own infrastructure
code without friction. The AGPL protection matters for the control plane, not for the modules.

All repositories start private and become public at launch, except `orkstage-licensing`, which
stays private.

## 5. Contributions

- **CLA required** (CLA Assistant bot). Because the company distributes the core under both the
  AGPL and a commercial license, it needs the right to relicense contributions, and a DCO alone
  does not grant that. Keep the CLA short, in the style of the Apache ICLA (*draft needed*).
- Contributions to `ee/` are accepted under the same CLA.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) and `SECURITY.md` (private
  disclosure to security@orkstage.io) live in the organization's `.github` repository; each
  repository adds only what differs.

## 6. Trademark

"OrkStage" and the logo are trademarks; forks must use another name. Publish a short trademark
policy (*draft*), similar to those of other open core projects.

## 7. Editions and pricing (to validate)

| Edition | Who | Price model |
|---|---|---|
| Community | Anyone running it on their own infrastructure | Free (AGPL) |
| Enterprise (on your infrastructure) | Regulated or larger organizations | Annual subscription per managed instance or per organization, support included |
| OrkStage Cloud | Teams that want it hosted | Usage based (managed instances), Enterprise features as paid extras |

## 8. Implementation checklist

- [x] Root `LICENSE` (AGPL-3.0, official text)
- [x] `ee/LICENSE` (*draft* OrkStage Enterprise License)
- [x] `packages/licensing`: offline Ed25519 license verification, feature checks, tests
- [x] `GET /api/v1/license` and `402 ENTERPRISE_REQUIRED`
- [x] First EE module: audit export (`ee/api`)
- [ ] License headers and SPDX identifiers in source files (`SPDX-License-Identifier: AGPL-3.0-only`)
- [x] CONTRIBUTING, CODE_OF_CONDUCT, SECURITY and SUPPORT in the organization [`.github`](https://github.com/orkstage/.github) repository
- [ ] CLA bot, CLA text and trademark policy (*legal review*)
- [x] Console: edition badge
- [ ] Console: upgrade states for EE features, license settings page
- [ ] `orkstage-licensing` private signing tool
