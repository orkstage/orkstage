import type { PrismaClient } from '@orkstage/database';
import { sha256 } from '@orkstage/domain';
import type { PlatformConfig } from '@orkstage/runtime';
import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE } from '../common/auth.js';
import { CONFIG, PRISMA } from '../infra/infra.module.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

@Injectable()
export class SessionService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CONFIG) private readonly config: PlatformConfig,
  ) {}

  /** Creates a session and sets a secure, httpOnly cookie holding the opaque token. */
  async start(userId: string, method: string, req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.prisma.session.create({
      data: {
        userId,
        tokenHash: sha256(token),
        method,
        ip: req.ip,
        userAgent: req.headers['user-agent']?.slice(0, 300),
        expiresAt,
      },
    });
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: this.config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    });
  }

  async end(sessionId: string, reply: FastifyReply): Promise<void> {
    await this.prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }
}
