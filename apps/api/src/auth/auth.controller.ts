// SPDX-License-Identifier: AGPL-3.0-only
import { devLoginSchema, type MeResponse } from '@orkstage/contracts';
import type { PrismaClient } from '@orkstage/database';
import type { PlatformConfig } from '@orkstage/runtime';
import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
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
      scope: 'openid email profile',
      response_type: 'code',
      state: flow.state,
      nonce: flow.nonce,
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
    let claims: client.IDToken;
    try {
      const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims()!;
      // Provider access/refresh tokens are intentionally discarded: no downstream use yet (spec §14).
    } catch (err) {
      await this.audit.record({ resourceType: 'Session', action: 'LOGIN', result: 'FAILURE', correlationId, ip: req.ip, changes: { method: key, reason: (err as Error).name } });
      throw new AppError(401, 'OIDC_VALIDATION_FAILED', 'Sign-in could not be verified.');
    }

    const user = await this.resolveUser(provider.key, claims);
    if (!user) {
      await this.audit.record({ resourceType: 'Session', action: 'LOGIN', result: 'DENIED', correlationId, ip: req.ip, changes: { method: key, reason: 'no-account' } });
      return reply.redirect(`${this.config.WEB_PUBLIC_URL}/login?error=no_account`, 302);
    }
    await this.sessions.start(user.id, key, req, reply);
    await this.audit.record({ actor: { id: user.id, label: user.email }, resourceType: 'Session', resourceId: user.id, action: 'LOGIN', correlationId, ip: req.ip, userAgent: req.headers['user-agent'], changes: { method: key } });
    return reply.redirect(`${this.config.WEB_PUBLIC_URL}${flow.returnTo}`, 302);
  }

  /**
   * Account resolution: existing link → that user; otherwise link to an existing user with the
   * same verified email; otherwise create a viewer only if a tenant explicitly allows the
   * email domain. Unknown people never get an account by default.
   */
  private async resolveUser(providerKey: string, claims: client.IDToken) {
    const providerRow = await this.oidc.providerRow(this.oidc.get(providerKey)!);
    const linked = await this.prisma.externalIdentity.findUnique({
      where: { providerId_subject: { providerId: providerRow.id, subject: claims.sub } },
      include: { user: true },
    });
    if (linked) {
      await this.prisma.externalIdentity.update({ where: { id: linked.id }, data: { lastLoginAt: new Date() } });
      return linked.user.disabledAt ? null : linked.user;
    }

    // Link by email only when the provider asserts it is verified. Entra's `email` claim is
    // user-editable, so it counts only with `xms_edov` (domain-owner verified); otherwise this
    // would allow account takeover ("nOAuth"). `preferred_username` is never trusted.
    const verified = claims.email_verified === true || claims.xms_edov === true;
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
    if (!verified || !email.includes('@')) return null;

    let user = await this.prisma.user.findUnique({ where: { email } });
    // Pending invitations for this address: the first SSO sign in creates the account with those
    // memberships and accepts them (an explicit invitation wins over domain auto join).
    const invitations = await this.prisma.invitation.findMany({ where: { email, acceptedAt: null, expiresAt: { gt: new Date() } } });
    if (!user && invitations.length > 0) {
      user = await this.prisma.user.create({
        data: { email, name: String(claims.name ?? email), memberships: { create: invitations.map((i) => ({ tenantId: i.tenantId, role: i.role })) } },
      });
      await this.prisma.invitation.updateMany({ where: { id: { in: invitations.map((i) => i.id) } }, data: { acceptedAt: new Date() } });
    }
    if (!user) {
      const domain = email.split('@')[1]!;
      // Auto join only when exactly one tenant claims the domain: with several, there is no safe way
      // to tell which customer the person belongs to, so they need an explicit invitation instead.
      const tenants = await this.prisma.tenant.findMany({ where: { allowedEmailDomains: { has: domain } }, select: { id: true }, take: 2 });
      if (tenants.length !== 1) return null;
      const tenant = tenants[0]!;
      user = await this.prisma.user.create({
        data: {
          email,
          name: String(claims.name ?? email),
          memberships: { create: { tenantId: tenant.id, role: 'CustomerViewer' } },
        },
      });
    }
    if (user.disabledAt) return null;
    await this.prisma.externalIdentity.create({
      data: { providerId: providerRow.id, subject: claims.sub, userId: user.id, email, lastLoginAt: new Date() },
    });
    return user;
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
