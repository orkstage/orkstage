import { defineAbilityFor, type Action, type SubjectName, subject as tagSubject } from '@co/authorization';
import type { PrismaClient } from '@co/database';
import { sha256 } from '@co/domain';
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
import { PRISMA } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';
import { AppError, forbidden } from './errors.js';

export const SESSION_COOKIE = 'co_session';
const IS_PUBLIC = 'co:isPublic';
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Marks a route as reachable without a session (login, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Resolves the session cookie to a principal. Sessions are opaque random tokens; only their
 * SHA-256 is stored, so a database leak does not leak usable sessions.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
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
}

/** Rejects state-changing requests without the custom CSRF header (see docs/API.md). */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    if (req.headers['x-co-csrf'] !== '1') throw new AppError(403, 'CSRF_REJECTED', 'Missing CSRF header.');
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

export function isPlatformStaff(p: RequestPrincipal): boolean {
  return Boolean(p.platformRole);
}

/**
 * Database filter limiting rows to tenants the caller belongs to. Platform staff see all
 * tenants. This is one layer of defense in depth; CASL checks on loaded records are another.
 */
export function tenantScope(p: RequestPrincipal): { tenantId?: { in: string[] } } {
  return isPlatformStaff(p) ? {} : { tenantId: { in: p.memberships.map((m) => m.tenantId) } };
}

/** Throws 403 unless the principal may perform `action` on the record/subject. */
export function authorize(p: RequestPrincipal, action: Action, type: SubjectName, record?: { tenantId?: string | null }) {
  const target = record ? tagSubject(type, { ...record }) : type;
  if (!p.ability.can(action, target)) throw forbidden();
}
