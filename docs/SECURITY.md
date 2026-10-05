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
| Secrets | Cloud target config is rejected if it contains secret-like keys; credentials are references (`env://…`, later a secret manager). Services receive secret *references*. |
| Logging | Pino with redaction of tokens, secrets, cookies, authorization headers. Errors return a code and correlation id, never stack traces. |
| Rate limits | Global per-client ceiling; stricter limits on login, deploy, destroy, target validation, template publish. |
| Audit | Append-only: a Postgres trigger rejects `UPDATE`/`DELETE` on `AuditEvent`. |
| Headers | Helmet with a restrictive CSP. |
| Supply chain | pnpm build scripts are allow-listed (`pnpm-workspace.yaml`); install-time telemetry denied; very recent releases avoided (minimum release age). |

## Not yet (tracked)

- AWS external-id and per-service permission probing (needs the OpenTofu runner milestone).
- Secret manager resolver (AWS Secrets Manager) instead of `env://`.
- MFA policy, session listing/revocation UI, invitation acceptance flow.
- Dependency and container image scanning in CI.
- Webhook signature verification (no inbound webhooks exist yet).

Report vulnerabilities privately to the platform team; do not open public issues.
