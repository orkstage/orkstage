# OrkStage open core: Community and Enterprise

**Model:** an AGPL-3.0 core plus commercial Enterprise features in a private repository
(`orkstage-ee`) mounted as a git submodule at `apps/api/src/ee`. Open core was decided on October 5,
2026; on October 16, 2026 the Enterprise source moved from public `ee/` directories to that private
repository. This document is the plan; the legal texts are adopted as version 1.0: the
[Enterprise License](../LICENSE-ENTERPRISE),
the [CLA](https://github.com/orkstage/.github/blob/main/CLA.md) and the [trademark policy](https://github.com/orkstage/.github/blob/main/TRADEMARKS.md).

## 1. Principles

1. **The core is complete.** A team can run Community on its own infrastructure and operate
   production workloads on AWS: templates, multicloud placement, tenant limits, policies and cost,
   deployments, health, incidents, status pages, notifications, audit log, API keys, webhooks,
   the CLI and IaC import. Enterprise adds *organizational scale and compliance*, not basic
   usefulness.
2. **One codebase, two images.** The public images (`ghcr.io/orkstage/platform`) are the
   Community edition, built without the private `orkstage-ee` submodule, so no Enterprise code is
   published. Enterprise subscribers get an image built from the same source with the submodule,
   distributed privately, and a signed license key turns its features on. No separate fork, no
   feature drift: `apps/api/src/enterprise.ts` loads the Enterprise module only when
   `src/ee/ee.module.js` exists.
3. **Clear boundary.** Everything in the public repositories is AGPL-3.0 (the modules are
   Apache-2.0). The Enterprise source is under the OrkStage Enterprise License
   ([LICENSE-ENTERPRISE](../LICENSE-ENTERPRISE)); it is private, and customers and evaluators get
   read access on request (hello@orkstage.io). Core code never imports from `ee/`; the Enterprise
   module plugs into the core through extension points.
4. **No dark patterns.** Community never needs to contact our servers; license checks are
   offline (signature verification). Usage telemetry, if it is ever added, will be opt in.

## 2. Feature split

| Area | Community (AGPL) | Enterprise (`orkstage-ee`) |
|---|---|---|
| Provisioning | Templates, visual builder, AWS through OpenTofu, mock provider, DAG, retries, drift detection | Policy packs (rule sets in the style of CIS and SOC 2), custom policy authoring, cost budgets per team |
| Multicloud | Placement per resource, cross cloud strategy | The other provider adapters (now in preview): **to be decided**. The recommendation is Community, to drive adoption |
| Governance | 7 built in roles, approvals for high risk production changes, audit log | Custom roles and fine grained permissions, multistep approval workflows, change windows, **audit export** (JSON or CSV, SIEM streaming) and retention policies |
| Identity | Development login, OIDC (Entra, Google, GitLab through configuration) | SAML 2.0 SSO, SCIM provisioning, enforced SSO and MFA policies, session policies |
| Organizations | One organization, many tenants | Multiple organizations, delegated administration, white label status pages with custom domains |
| Integrations | API keys, webhooks, CI intake, CLI, IaC import | Provisioning of private connectivity (VPN, interconnect), ServiceNow and Jira change management, PagerDuty and Opsgenie |
| Observability | Health, incidents, status pages, logs and metrics through adapters | Long term metrics retention, SLO management, advanced incident analytics |
| Support | Community support in GitHub Discussions | Support backed by an SLA, security advisories before public disclosure |

The first Enterprise module is **audit export** (`orkstage-ee`). It proves the boundary, the
license gating and the packaging end to end.

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
orkstage            AGPL core (api, worker, packages)                  public
orkstage-ee         Enterprise source, submodule at apps/api/src/ee    private
orkstage-console    AGPL console                                       public
orkstage-cli        AGPL (ork CLI + scan engine)                       public
orkstage-modules    Apache-2.0 (reusable OpenTofu modules)             public
orkstage-site       site + docs (code MIT, content CC BY 4.0)          public
orkstage-dev        meta repository: submodules + compose (MIT)        private for now
orkstage-licensing  license signing service and keys                  private
```

The OpenTofu modules use Apache-2.0 so that users can copy them into their own infrastructure
code without friction. The AGPL protection matters for the control plane, not for the modules.

`orkstage-ee` and `orkstage-licensing` stay private. Console screens for Enterprise features
live in the console and are shown only when the license includes the feature; if they ever need
private code, they get their own private submodule the same way.

## 5. Contributions

- **CLA required** (CLA Assistant bot). Because the company distributes the core under both the
  AGPL and a commercial license, it needs the right to relicense contributions, and a DCO alone
  does not grant that. The [CLA](https://github.com/orkstage/.github/blob/main/CLA.md) follows the Apache ICLA model, with an organization
  section, and CLA Assistant Lite (`.github/workflows/cla.yml` in every repository) records it.
- Contributions to `orkstage-ee` are accepted under the same CLA.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) and `SECURITY.md` (private
  disclosure to security@orkstage.io) live in the organization's `.github` repository; each
  repository adds only what differs.

## 6. Trademark

"OrkStage" and the logo are trademarks; forks must use another name. Publish a short trademark
policy: [TRADEMARKS.md](https://github.com/orkstage/.github/blob/main/TRADEMARKS.md).

## 7. Editions and pricing (to validate)

| Edition | Who | Price model |
|---|---|---|
| Community | Anyone running it on their own infrastructure | Free (AGPL) |
| Enterprise (on your infrastructure) | Regulated or larger organizations | Annual subscription per managed instance or per organization, support included |
| OrkStage Cloud | Teams that want it hosted | Usage based (managed instances), Enterprise features as paid extras |

## 8. Implementation checklist

- [x] Root `LICENSE` (AGPL-3.0, official text)
- [x] `LICENSE-ENTERPRISE` (OrkStage Enterprise License 1.0)
- [x] `packages/licensing`: offline Ed25519 license verification, feature checks, tests
- [x] `GET /api/v1/license` and `402 ENTERPRISE_REQUIRED`
- [x] First EE module: audit export (`orkstage-ee`)
- [x] Enterprise source in the private `orkstage-ee` submodule, loaded only when present
- [ ] License headers and SPDX identifiers in source files (`SPDX-License-Identifier: AGPL-3.0-only`)
- [x] CONTRIBUTING, CODE_OF_CONDUCT, SECURITY and SUPPORT in the organization [`.github`](https://github.com/orkstage/.github) repository
- [x] CLA bot, CLA text and trademark policy (version 1.0)
- [x] Console: edition badge
- [ ] Console: upgrade states for EE features, license settings page
- [ ] `orkstage-licensing` private signing tool
