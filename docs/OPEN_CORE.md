# OrkStage open core: Community and Enterprise

**Model:** AGPL-3.0 core + commercial Enterprise features in `ee/` directories (the model used by
Formbricks, Cal.com and others). Decided 2026-10-05. This document is the plan; legal texts
marked *draft* need review by counsel before any public release.

## 1. Principles

1. **The core is complete.** A team can self-host Community and run production workloads on AWS:
   templates, multi-cloud placement, plans/policies/cost, deployments, health, incidents, status
   pages, notifications, audit log, API keys, webhooks, CLI and IaC import. Enterprise adds
   *organizational scale and compliance*, not basic usefulness.
2. **One codebase, one build.** Enterprise code ships in the same images under `ee/` and is
   activated by a signed license key. No separate fork, no feature drift.
3. **Clear boundary.** Everything outside `ee/` is AGPL-3.0. Code inside `ee/` is under the
   OrkStage Enterprise License (source-available, commercial use requires a subscription). Core
   code must never import from `ee/`; `ee/` plugs into core through extension points.
4. **No dark patterns.** No phone-home requirement for Community; license checks are offline
   (signature verification). Usage telemetry, if ever added, is opt-in.

## 2. Feature split

| Area | Community (AGPL) | Enterprise (`ee/`) |
|---|---|---|
| Provisioning | Templates, visual builder, AWS via OpenTofu, mock provider, DAG, retries, drift flagging | Policy packs (CIS/SOC2-style rule sets), custom policy authoring, cost budgets per team |
| Multi-cloud | Per-resource placement, cross-cloud strategy | Azure/OCI/GCP adapters **TBD** — recommended Community to drive adoption; revisit when adapters exist |
| Governance | Roles (7 built-in), approvals for high-risk prod changes, audit log | Custom roles & fine-grained permissions, multi-step approval workflows, change windows, **audit export** (JSON/CSV, SIEM streaming) and retention policies |
| Identity | Dev login, OIDC (Entra/Google/GitLab via config) | SAML 2.0 SSO, SCIM provisioning, enforced SSO/MFA policies, session policies |
| Organizations | One organization, many tenants | Multiple organizations, delegated administration, white-label status pages/custom domains for status |
| Integrations | API keys, webhooks, CI intake, CLI, IaC import | Private connectivity provisioning (VPN/interconnect), ServiceNow/Jira change management, PagerDuty/Opsgenie |
| Observability | Health, incidents, status pages, logs/metrics via adapters | Long-term metrics retention, SLO management, advanced incident analytics |
| Support | Community (GitHub Discussions) | SLA-backed support, security advisories ahead of disclosure |

The first Enterprise module implemented is **audit export** (`ee/`), proving the boundary,
license gating and packaging end to end.

## 3. Licensing mechanics

- **License key:** a compact signed token `orkstage-license.v1.<payload>.<signature>`; payload is
  JSON `{ id, customer, edition, features[], seats?, issuedAt, expiresAt }`, signed with
  **Ed25519**. The platform embeds only the public key (`packages/licensing`) and verifies
  offline. Configure via `ORKSTAGE_LICENSE_KEY`.
- **Behaviour:** invalid or missing key → Community. Expired key → 14-day grace period with a
  banner, then Enterprise features switch off (data is never deleted or locked).
- **Gating:** `licensing.has('audit.export')` server-side; the console reads `GET /license` for
  visibility only. The API returns `402 ENTERPRISE_REQUIRED` for gated endpoints.
- **Key issuance:** a private signing tool (separate private repo `orkstage-licensing`), never
  in the public repos.

## 4. Repository layout (polyrepo)

```text
orkstage            AGPL core (api, worker, packages) + ee/            ← public
orkstage-console    AGPL console + ee/ (console screens for EE)        ← public
orkstage-cli        AGPL (ork CLI + scan engine)                        ← public
orkstage-modules    AGPL? → recommend Apache-2.0 (reusable IaC modules) ← public
orkstage-site       site + docs (content CC BY 4.0, code MIT)           ← public
orkstage-dev        meta repo: submodules + compose                     ← public
orkstage-licensing  license signing service and keys                    ← private
```

OpenTofu modules under Apache-2.0 lowers friction for users who copy modules into their own
infrastructure; the AGPL protection matters for the control plane, not for modules.

## 5. Contributions

- **CLA required** (CLA Assistant bot). Because the company distributes core under both AGPL
  and a commercial license, it needs the right to relicense contributions; a DCO alone does not
  grant that. Keep the CLA short, Apache-ICLA style (*draft needed*).
- Contributions to `ee/` are accepted under the same CLA.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md` (private
  disclosure address `security@orkstage.io`).

## 6. Trademark

"OrkStage" and the logo are trademarks; forks must rename. Publish a short trademark policy
(*draft*), similar to those of other open-core projects.

## 7. Editions and pricing (to validate)

| Edition | Who | Price model |
|---|---|---|
| Community | Self-hosted, any size | Free (AGPL) |
| Enterprise (self-hosted) | Regulated / larger orgs | Annual subscription per managed instance or per org, includes support |
| OrkStage Cloud | Teams wanting it hosted | Usage-based (managed instances), Enterprise features as add-ons |

## 8. Implementation checklist

- [x] Root `LICENSE` (AGPL-3.0, official text)
- [x] `ee/LICENSE` (*draft* OrkStage Enterprise License)
- [x] `packages/licensing`: offline Ed25519 license verification + feature checks, tests
- [x] `GET /api/v1/license` and `402 ENTERPRISE_REQUIRED`
- [x] First EE module: audit export (`ee/api`)
- [ ] License headers / SPDX identifiers in source files (`SPDX-License-Identifier: AGPL-3.0-only`)
- [ ] CLA bot, CONTRIBUTING, CODE_OF_CONDUCT, trademark policy (*legal review*)
- [ ] Console: edition badge, EE feature upsell states, license settings page
- [ ] `orkstage-licensing` private signing tool
