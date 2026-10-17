// SPDX-License-Identifier: AGPL-3.0-only
import { devLoginSchema, type MeResponse, type SessionDto } from '@orkstage/contracts';
import type { PrismaClient } from '@orkstage/database';
import type { PlatformConfig } from '@orkstage/runtime';
import { Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as client from 'openid-client';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { CorrelationId, CurrentPrincipal, Public, Scope } from '../common/auth.js';
import { AppError, notFound } from '../common/errors.js';
import { ApiZodBody, ZodBody } from '../common/validation.js';
import { CONFIG, PRISMA } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';
import { IdentityLinker, type ExternalIdentityClaims } from './identity-linker.js';
import { OidcService } from './oidc.service.js';
import { SessionService } from './session.service.js';

const FLOW_COOKIE = 'orkstage_oidc_flow';

interface OidcFlow {
  provider: string;
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

/** Only same-site relative paths, so the login flow cannot be turned into an open redirect. */
function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CONFIG) private readonly config: PlatformConfig,
    private readonly sessions: SessionService,
    private readonly oidc: OidcService,
    private readonly audit: AuditService,
    private readonly linker: IdentityLinker,
  ) {}

  @Public()
  @Get('auth/providers')
  providers() {
    return this.oidc.providers.map((p) => ({ key: p.key, name: p.name }));
  }

  /** Local development only. Refused at startup in production (see @orkstage/runtime config). */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auth/dev-login')
  @HttpCode(204)
  @ApiZodBody(devLoginSchema)
  async devLogin(
    @ZodBody(devLoginSchema) body: z.infer<typeof devLoginSchema>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @CorrelationId() correlationId: string,
  ) {
    if (!this.config.AUTH_DEV_LOGIN_ENABLED) throw notFound('Route');
    const user = await this.prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!user || user.disabledAt) {
      await this.audit.record({ resourceType: 'Session', action: 'LOGIN', result: 'DENIED', correlationId, ip: req.ip, changes: { method: 'dev', email: body.email } });
      throw new AppError(401, 'INVALID_LOGIN', 'Unknown user.');
    }
    await this.sessions.start(user.id, 'dev', req, reply);
    await this.audit.record({ actor: { id: user.id, label: user.email }, resourceType: 'Session', resourceId: user.id, action: 'LOGIN', correlationId, ip: req.ip, userAgent: req.headers['user-agent'], changes: { method: 'dev' } });
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('auth/oidc/:provider/login')
  async oidcLogin(@Param('provider') key: string, @Query('returnTo') returnTo: string, @Res() reply: FastifyReply) {
    const provider = this.oidc.get(key);
    if (!provider) throw notFound('Identity provider');
    const cfg = await this.oidc.configuration(provider);
    const flow: OidcFlow = {
      provider: key,
      state: client.randomState(),
      nonce: client.randomNonce(),
      verifier: client.randomPKCECodeVerifier(),
      returnTo: safeReturnTo(returnTo),
    };
    const url = client.buildAuthorizationUrl(cfg, {
      redirect_uri: this.oidc.redirectUri(key),
      scope: provider.kind === 'oauth2' ? 'read:user user:email' : 'openid email profile',
      response_type: 'code',
      state: flow.state,
      ...(provider.kind === 'oidc' ? { nonce: flow.nonce } : {}),
      code_challenge: await client.calculatePKCECodeChallenge(flow.verifier),
      code_challenge_method: 'S256',
    });
    reply.setCookie(FLOW_COOKIE, JSON.stringify(flow), {
      httpOnly: true,
      signed: true,
      secure: this.config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/v1/auth/oidc',
      maxAge: 600,
    });
    return reply.redirect(url.href, 302);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('auth/oidc/:provider/callback')
  async oidcCallback(
    @Param('provider') key: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @CorrelationId() correlationId: string,
  ) {
    const provider = this.oidc.get(key);
    if (!provider) throw notFound('Identity provider');
    const raw = req.cookies[FLOW_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    reply.clearCookie(FLOW_COOKIE, { path: '/api/v1/auth/oidc' });
    if (!unsigned?.valid || !unsigned.value) throw new AppError(400, 'OIDC_FLOW_INVALID', 'Login session expired. Start again.');
    const flow = JSON.parse(unsigned.value) as OidcFlow;
    if (flow.provider !== key) throw new AppError(400, 'OIDC_FLOW_INVALID', 'Login session mismatch.');

    const cfg = await this.oidc.configuration(provider);
    const currentUrl = new URL(`${this.config.WEB_PUBLIC_URL}${req.url}`);
    let identity: ExternalIdentityClaims;
    try {
      if (provider.kind === 'oauth2') {
        const tokens = await client.authorizationCodeGrant(cfg, currentUrl, { pkceCodeVerifier: flow.verifier, expectedState: flow.state });
        identity = await this.oidc.githubIdentity(provider, tokens.access_token);
      } else {
        const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
          pkceCodeVerifier: flow.verifier,
          expectedState: flow.state,
          expectedNonce: flow.nonce,
          idTokenExpected: true,
        });
        const claims = tokens.claims()!;
        // Link by email only when the provider asserts it is verified. Entra's `email` claim is
        // user-editable, so it counts only with `xms_edov` (domain-owner verified); otherwise this
        // would allow account takeover ("nOAuth"). `preferred_username` is never trusted.
        identity = {
          subject: claims.sub,
          email: typeof claims.email === 'string' ? claims.email : undefined,
          emailVerified: claims.email_verified === true || claims.xms_edov === true,
          name: typeof claims.name === 'string' ? claims.name : undefined,
        };
      }
      // Provider access/refresh tokens are intentionally discarded: no downstream use yet (spec §14).
    } catch (err) {
      await this.audit.record({ resourceType: 'Session', action: 'LOGIN', result: 'FAILURE', correlationId, ip: req.ip, changes: { method: key, reason: (err as Error).name } });
      throw new AppError(401, 'OIDC_VALIDATION_FAILED', 'Sign-in could not be verified.');
    }

    const providerRow = await this.oidc.providerRow(provider);
    const user = await this.linker.resolve(providerRow.id, identity);
    if (!user) {
      await this.audit.record({ resourceType: 'Session', action: 'LOGIN', result: 'DENIED', correlationId, ip: req.ip, changes: { method: key, reason: 'no-account' } });
      return reply.redirect(`${this.config.WEB_PUBLIC_URL}/login?error=no_account`, 302);
    }
    await this.sessions.start(user.id, key, req, reply);
    await this.audit.record({ actor: { id: user.id, label: user.email }, resourceType: 'Session', resourceId: user.id, action: 'LOGIN', correlationId, ip: req.ip, userAgent: req.headers['user-agent'], changes: { method: key } });
    return reply.redirect(`${this.config.WEB_PUBLIC_URL}${flow.returnTo}`, 302);
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(
    @CurrentPrincipal() p: RequestPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
    @CorrelationId() correlationId: string,
  ) {
    await this.sessions.end(p.sessionId, reply);
    await this.audit.record({ principal: p, resourceType: 'Session', resourceId: p.sessionId, action: 'LOGOUT', correlationId });
  }

  /** The signed in person's sessions (browser sign ins), newest first. API keys cannot list them. */
  @Get('me/sessions')
  async mySessions(@CurrentPrincipal() p: RequestPrincipal): Promise<SessionDto[]> {
    const rows = await this.prisma.session.findMany({
      where: { userId: p.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      take: 50,
    });
    return rows.map((s) => ({
      id: s.id,
      method: s.method,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      current: s.id === p.sessionId,
    }));
  }

  /** Signs one of the person's own sessions out (a lost laptop, a shared computer). */
  @Delete('me/sessions/:id')
  @HttpCode(204)
  async revokeSession(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string, @CorrelationId() correlationId: string) {
    const { count } = await this.prisma.session.updateMany({ where: { id, userId: p.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (count === 0) throw notFound('Session');
    await this.audit.record({ principal: p, resourceType: 'Session', resourceId: id, action: 'REVOKE', correlationId });
  }

  /** Signs every other session of the person out, keeping this one. */
  @Post('me/sessions/revoke-others')
  async revokeOtherSessions(@CurrentPrincipal() p: RequestPrincipal, @CorrelationId() correlationId: string): Promise<{ revoked: number }> {
    const { count } = await this.prisma.session.updateMany({ where: { userId: p.userId, revokedAt: null, id: { not: p.sessionId } }, data: { revokedAt: new Date() } });
    await this.audit.record({ principal: p, resourceType: 'Session', resourceId: p.sessionId, action: 'REVOKE_OTHERS', correlationId, changes: { revoked: count } });
    return { revoked: count };
  }

  @Scope('*')
  @Get('me')
  async me(@CurrentPrincipal() p: RequestPrincipal): Promise<MeResponse> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId: p.userId },
      include: { tenant: true },
      orderBy: { createdAt: 'asc' },
    });
    return {
      user: { id: p.userId, email: p.email, name: p.name, platformRole: p.platformRole ?? null },
      memberships: memberships.map((m) => ({ tenantId: m.tenantId, tenantName: m.tenant.name, tenantSlug: m.tenant.slug, role: m.role })),
      rules: p.ability.rules,
      ...(p.apiKey ? { apiKey: { id: p.apiKey.id, name: p.apiKey.name, prefix: p.apiKey.prefix, scopes: p.apiKey.scopes } } : {}),
    };
  }
}
