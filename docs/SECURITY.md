# Security

## Implemented

| Area | Control |
|---|---|
| Sessions | 32-byte random opaque token in an httpOnly `SameSite=Lax` cookie (`Secure` in production); only its SHA-256 is stored; 12 h expiry; revocation on logout. |
| CSRF | All state-changing requests require `x-co-csrf: 1`; the API grants no cross-origin CORS, so browsers cannot send it cross-site. |
| OIDC | Authorization code + PKCE (S256), `state` and `nonce` verified, flow kept in a signed short-lived cookie, `returnTo` restricted to relative paths. Provider tokens are discarded. |
| Account linking | Only by provider-verified email (`email_verified`, or Entra `xms_edov`); `preferred_username` is never trusted (prevents "nOAuth" takeover). Unknown users get no account unless a tenant allow-lists their domain. |
| Dev login | Disabled unless `AUTH_DEV_LOGIN_ENABLED=true`; startup fails if enabled with `NODE_ENV=production`. |
| Authorization | CASL abilities per request; tenant-owned queries are scoped to memberships and records are re-checked after loading. Foreign records return 404, not 403. |
| Secrets | Cloud target config is rejected if it contains secret-like keys; credentials are references (`env://NAME`, `aws-sm://<name-or-arn>`), resolved at use and never stored. Services receive secret *references*. Webhook signing secrets are encrypted at rest (AES-256-GCM, `ENCRYPTION_KEY`). |
| Cloud access | AWS: AssumeRole with an external id into a customer-created role (`infra/aws/orkstage-deployment-role.yaml`), scoped to OrkStage names; validation simulates the role's permissions before deploying. OpenTofu state holds no secret values (write-only attributes); runs happen in throwaway containers. |
| Change safety | Real provider plans before applying changes; deletions/replacements in production need approval. Drift scans report out-of-band changes (attribute names only). |
| API keys & webhooks | Keys are scoped, hashed (SHA-256), expirable and revocable; a key can never mint keys. Outbound webhooks are HMAC-SHA256 signed with a timestamp (5-minute replay window) and blocked from private networks (SSRF guard). |
| Logging | Pino with redaction of tokens, secrets, cookies, authorization headers. Errors return a code and correlation id, never stack traces. |
| Rate limits | Global per-client ceiling; stricter limits on login, deploy, destroy, target validation, template publish. |
| Audit | Append-only: a Postgres trigger rejects `UPDATE`/`DELETE` on `AuditEvent`. |
| Headers | Helmet with a restrictive CSP. |
| Supply chain | pnpm build scripts are allow-listed (`pnpm-workspace.yaml`); install-time telemetry denied; very recent releases avoided (minimum release age). |

## Not yet (tracked)

- MFA policy, session listing/revocation UI, invitation acceptance flow.
- Container image scanning in CI (dependencies are audited with `pnpm audit`).
- Runner isolation without the Docker socket (ECS RunTask / Kubernetes Job with a scoped role).
- OIDC providers beyond Entra are read from `OIDC_<KEY>_*` without startup validation.

Report vulnerabilities privately to the platform team; do not open public issues.
