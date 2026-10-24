# ADR 0011: Authentication, single sign on and API keys

**Status:** accepted on October 23, 2026. Records the design built since ADR 0004 (orkstage-dev
`docs/open-items.md`, item 28).

## Context

OrkStage is installed by an operator and used by the operator's staff and by their customers'
teams. Both want to sign in with the identity provider they already run, and neither wants
OrkStage to hold passwords. Scripts and CI need credentials that are narrower than a person and
that stop working when that person leaves. ADR 0004 chose opaque server side sessions and CASL
abilities; this ADR records how people and programs get a principal.

## Decision

1. **No passwords.** People sign in through OpenID Connect providers or GitHub. A development login
   by email exists for local work only: it is off unless `AUTH_DEV_LOGIN_ENABLED=true`, and the API
   refuses to start with it on in production.

2. **Providers come from configuration.** Each `OIDC_<KEY>_ISSUER`, `_CLIENT_ID` and
   `_CLIENT_SECRET` set enables one provider at `/api/v1/auth/oidc/<key>/login` (Microsoft Entra
   ID, Google and GitLab get display names; any other issuer works). GitHub and GitHub Enterprise
   Server use OAuth 2 (`OAUTH_GITHUB_*`). The client secret stays in the environment: the
   `IdentityProvider` row stores `env://<VAR>`.

3. **A strict flow, through the console's origin.** Authorization code with PKCE (S256), `state`,
   and `nonce` for OIDC, held in a signed, short lived cookie scoped to the callback path. The
   redirect URI is on the console's public URL, so the cookie stays first party behind the proxy.
   ID tokens are verified by `openid-client` (signature against the provider's keys, issuer,
   audience, expiry, nonce). Provider access and refresh tokens are discarded: OrkStage calls
   nothing on the person's behalf.

4. **Accounts link by verified email only.** An existing link (provider and subject) wins.
   Otherwise the email must be verified (`email_verified`, or `xms_edov` for Entra; GitHub's
   primary verified address); `preferred_username` is never used. A matching user is linked; a
   person with pending invitations gets those memberships; otherwise a person joins as
   `CustomerViewer` only when exactly one tenant allows their email domain. Anyone else is refused
   (`/login?error=no_account`). Disabled users are always refused.

5. **Sessions are rows, not tokens with claims.** A random 32 byte token in an `httpOnly`,
   `SameSite=Lax` cookie (`Secure` in production); Postgres keeps only its SHA-256. Twelve hours
   absolute, `SESSION_IDLE_MINUTES` idle (120 by default), revoked on sign out. People list their
   sessions and revoke one or all others. A change of role or a disabled account applies on the
   next request.

6. **CSRF by a custom header.** Every request that changes state needs `x-orkstage-csrf: 1`, and
   the API grants no cross origin access, so another site cannot send it. Bearer requests are
   exempt.

7. **API keys act for their creator, with less.** `ork_<live|test>_<prefix>_<secret>`, shown once,
   stored as SHA-256. A key has one role (never an owner role), one tenant or none (platform roles),
   at least one scope (`instances:deploy`, `templates:write`, `audit:read` and so on) and an
   optional expiry. A route without a declared scope refuses keys, so keys cannot manage keys,
   sessions or invitations. A key stops working when its creator is disabled or loses the platform
   role or the tenant membership the key relies on.

8. **Invitations.** A tenant owner invites an email with a role; a 32 byte token (stored hashed)
   valid seven days, sent by email and shown to the inviter. Accepting needs a signed in person with
   the same email. A first sign in also accepts pending invitations.

9. **Abuse limits.** Sign in, callback, invitation and key creation routes have their own per
   minute limits on top of the global one, counted in Redis per client address.

10. **Enterprise identity stays out of the core.** SAML 2.0, SCIM provisioning, enforced SSO and
    MFA policies, session policies and custom roles are Enterprise features (`auth.saml`,
    `auth.scim`, `rbac.custom-roles`), built in the private `orkstage-ee` module behind
    `@RequiresFeature`. With OIDC, MFA is the identity provider's job.

## Consequences

- No password storage, reset flow or MFA code in the core; an installation needs at least one
  identity provider before anyone but the development login can sign in.
- Revocation is immediate for sessions and keys, at the cost of one indexed query per request
  (`lastSeenAt` and `lastUsedAt` are written at most every five minutes and every minute).
- Only Entra's variables are validated at startup; other providers are read as they are found, so
  a typo disables that provider silently (SECURITY.md lists it).
- `DELETE /api-keys/:id` loads the key before checking the tenant and answers 403 for a key of
  another tenant, where the rest of the API answers 404 (ADR 0004). To be aligned.
