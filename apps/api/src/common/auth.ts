// SPDX-License-Identifier: AGPL-3.0-only
import {
  defineAbilityFor,
  subject as tagSubject,
  type Action,
  type ApiKeyScope,
  type PlatformRole,
  type SubjectName,
  type TenantRole,
} from '@orkstage/authorization';
import type { PrismaClient } from '@orkstage/database';
import { sha256 } from '@orkstage/domain';
import {
  createParamDecorator,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { PlatformConfig } from '@orkstage/runtime';
import { CONFIG, PRISMA } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';
import { AppError, forbidden } from './errors.js';

export const SESSION_COOKIE = 'orkstage_session';
const IS_PUBLIC = 'orkstage:isPublic';
const SCOPE = 'orkstage:apiKeyScope';
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const KEY_TOUCH_INTERVAL_MS = 60 * 1000;
const BEARER = /^Bearer\s+(ork_(?:live|test)_[a-f0-9]{8}_[A-Za-z0-9_-]{20,})$/;

/** Marks a route as reachable without a session (login, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Opens a route to API keys holding `scope`. Routes without it are closed to API keys
 * (default deny), so a new endpoint never becomes machine-accessible by accident.
 */
export const Scope = (scope: ApiKeyScope | '*') => SetMetadata(SCOPE, scope);

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = BEARER.exec(header.trim());
  if (!match) throw new AppError(401, 'INVALID_API_KEY', 'Malformed API key. Expected "Authorization: Bearer ork_<key>".');
  return match[1]!;
}

/**
 * Resolves the caller: an API key (`Authorization: Bearer ork_…`) or the session cookie.
 * Sessions and keys are opaque random tokens; only their SHA-256 is stored, so a database leak
 * does not leak usable credentials.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CONFIG) private readonly config: PlatformConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();

    const apiKeyToken = bearerToken(req);
    if (apiKeyToken) {
      const required = this.reflector.getAllAndOverride<ApiKeyScope | '*' | undefined>(SCOPE, [ctx.getHandler(), ctx.getClass()]);
      req.principal = await this.fromApiKey(apiKeyToken, req, required);
      return true;
    }

    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');

    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { include: { memberships: true } } },
    });
    const now = new Date();
    if (!session || session.revokedAt || session.expiresAt < now || session.user.disabledAt) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Your session has expired. Sign in again.');
    }
    // Idle timeout: a session unused for too long ends even before its absolute expiry.
    if (now.getTime() - session.lastSeenAt.getTime() > this.config.SESSION_IDLE_MINUTES * 60_000) {
      await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: now } });
      throw new AppError(401, 'UNAUTHENTICATED', 'Your session has expired. Sign in again.');
    }
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
    }

    const memberships = session.user.memberships.map((m) => ({ tenantId: m.tenantId, role: m.role }));
    const base = { userId: session.user.id, platformRole: session.user.platformRole, memberships };
    req.principal = {
      ...base,
      email: session.user.email,
      name: session.user.name,
      sessionId: session.id,
      ability: defineAbilityFor(base),
    };
    return true;
  }

  private async fromApiKey(token: string, req: FastifyRequest, required: ApiKeyScope | '*' | undefined): Promise<RequestPrincipal> {
    const key = await this.prisma.apiKey.findUnique({ where: { tokenHash: sha256(token) } });
    const now = new Date();
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < now)) {
      throw new AppError(401, 'INVALID_API_KEY', 'The API key is invalid, expired or revoked.');
    }
    // A key acts for its creator: it stops working when the creator is disabled, loses platform
    // access (platform keys) or leaves the key's tenant (tenant keys).
    const creator = await this.prisma.user.findUnique({ where: { id: key.createdById }, include: { memberships: { select: { tenantId: true } } } });
    const stillAllowed =
      creator &&
      !creator.disabledAt &&
      (key.role.startsWith('Platform') ? Boolean(creator.platformRole) : Boolean(creator.platformRole) || creator.memberships.some((m) => m.tenantId === key.tenantId));
    if (!stillAllowed) throw new AppError(401, 'INVALID_API_KEY', 'The API key is invalid, expired or revoked.');
    if (!required) throw new AppError(403, 'API_KEY_NOT_ALLOWED', 'This endpoint is not available to API keys.');
    if (required !== '*' && !key.scopes.includes(required)) {
      throw new AppError(403, 'API_KEY_SCOPE', `This API key lacks the "${required}" scope.`, { required });
    }
    if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > KEY_TOUCH_INTERVAL_MS) {
      await this.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: now, lastUsedIp: req.ip } });
    }
    const isPlatform = key.role.startsWith('Platform');
    const base = {
      userId: key.createdById,
      platformRole: isPlatform ? (key.role as PlatformRole) : null,
      memberships: !isPlatform && key.tenantId ? [{ tenantId: key.tenantId, role: key.role as TenantRole }] : [],
    };
    return {
      ...base,
      email: `${key.name} (${key.prefix})`,
      name: key.name,
      sessionId: '',
      ability: defineAbilityFor(base),
      apiKey: { id: key.id, name: key.name, prefix: key.prefix, scopes: key.scopes, organizationId: key.organizationId },
    };
  }
}

/**
 * Rejects state-changing requests without the custom CSRF header (see docs/API.md). API-key
 * requests are exempt: they carry no ambient browser credentials.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    if (req.headers.authorization?.startsWith('Bearer ')) return true;
    if (req.headers['x-orkstage-csrf'] !== '1') throw new AppError(403, 'CSRF_REJECTED', 'Missing CSRF header.');
    return true;
  }
}

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestPrincipal => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  if (!req.principal) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  return req.principal;
});

export const CorrelationId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest<FastifyRequest>().correlationId,
);

export { isPlatformStaff, scopedToTenant, tenantScope } from './tenancy.js';

/** Throws 403 unless the principal may perform `action` on the record/subject. */
export function authorize(p: RequestPrincipal, action: Action, type: SubjectName, record?: { tenantId?: string | null }) {
  const target = record ? tagSubject(type, { ...record }) : type;
  if (!p.ability.can(action, target)) throw forbidden();
}
