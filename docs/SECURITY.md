# Security

This page describes the security controls in the platform. To report a vulnerability, see
[Reporting a vulnerability](#reporting-a-vulnerability).

## Implemented

| Area | Control |
|---|---|
| Sessions | A 32 byte random opaque token in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production). Only its SHA-256 hash is stored. Sessions expire after 12 hours, or after `SESSION_IDLE_MINUTES` without use (120 by default), and are revoked on logout. People list their sessions and revoke them one by one or all others at once. See [ADR 0011](adr/0011-authentication-and-sso.md). |
| CSRF | Every state changing request needs the `x-orkstage-csrf: 1` header. The API grants no cross origin CORS, so browsers cannot send it from another site. |
| OIDC | Authorization code flow with PKCE (S256); `state` and `nonce` are verified; the flow state lives in a signed cookie with a short lifetime; `returnTo` accepts relative paths only. Provider tokens are discarded. |
| Account linking | Only by an email the provider verified (`email_verified`, or `xms_edov` for Entra). `preferred_username` is never trusted, which prevents "nOAuth" account takeover. Unknown users get no account unless a tenant allows their email domain. |
| Development login | Disabled unless `AUTH_DEV_LOGIN_ENABLED=true`. Startup fails if it is enabled with `NODE_ENV=production`. |
| Authorization | CASL abilities per request. Queries for tenant owned data are scoped to the caller's memberships, and records are checked again after loading. Foreign records return 404, not 403. |
| Secrets | Cloud target configuration is rejected if it contains keys that look like secrets. Credentials are references (`env://NAME`, `aws-sm://<name-or-arn>`), resolved when used and never stored. Services receive secret references. Webhook signing secrets are encrypted at rest (AES-256-GCM, `ENCRYPTION_KEY`). |
| OpenTofu runner | Every run happens in a throwaway runner with the module library read only. With `TOFU_RUNNER=docker` the worker holds the Docker socket (control of that host); with `ecs` or `kubernetes` it starts one ECS task or Job per run with a scoped role instead, the runner runs as an unprivileged user with a read only root file system, and credentials reach it through a file only that user can read, removed as soon as it is read, never through the task or Job definition (ADR 0016). |
| Cloud access | AWS: AssumeRole with an external id into a role the customer creates ([`infra/aws/orkstage-deployment-role.yaml`](../infra/aws/orkstage-deployment-role.yaml)), scoped to OrkStage resource names. Target validation simulates the role's permissions before any deployment. OpenTofu state holds no secret values (write only attributes), and every run happens in a throwaway container. |
| Change safety | Real provider plans run before changes are applied; deletions and replacements in production need approval. Drift scans report changes made outside OrkStage (attribute names only, never values). |
| API keys and webhooks | Keys are scoped, hashed (SHA-256), can expire and can be revoked; a key can never create keys. Outbound webhooks are signed with HMAC-SHA256 and a timestamp (5 minute replay window) and cannot target private networks (SSRF guard). |
| Logging | Pino redacts tokens, secrets, cookies and authorization headers. Errors return a code and a correlation id, never a stack trace. |
| Rate limits | A global ceiling per client, with stricter limits on login, deploy, destroy, target validation and template publishing. |
| Audit | Append only: a Postgres trigger rejects `UPDATE` and `DELETE` on `AuditEvent`. |
| Headers | Helmet with a restrictive Content Security Policy. |
| Supply chain | Trivy scans the dependencies, the platform image and the runner image in CI. pnpm build scripts are allow listed (`pnpm-workspace.yaml`), install time telemetry is denied, and very recent releases are avoided (minimum release age). |

## Not yet (tracked)

- MFA, SAML and SCIM (Enterprise, ADR 0011). With OIDC, the identity provider enforces MFA.
- OIDC providers other than Entra are read from `OIDC_<KEY>_*` without validation at startup.

## Reporting a vulnerability

Do not open a public issue. Report it privately through
[GitHub Security Advisories](https://github.com/orkstage/orkstage/security/advisories/new) or by
email to security@orkstage.io. The full policy, including response times, is in the
[organization security policy](https://github.com/orkstage/.github/blob/main/SECURITY.md).
