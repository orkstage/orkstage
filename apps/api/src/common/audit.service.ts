import type { PrismaClient } from '@co/database';
import { Inject, Injectable } from '@nestjs/common';
import { PRISMA } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';

export interface AuditInput {
  principal?: RequestPrincipal | null;
  /** Actor when there is no session yet (e.g. the login itself). */
  actor?: { id: string; label: string };
  tenantId?: string | null;
  resourceType: string;
  resourceId?: string | null;
  action: string;
  result?: 'SUCCESS' | 'DENIED' | 'FAILURE';
  correlationId?: string;
  ip?: string;
  userAgent?: string;
  changes?: Record<string, unknown>;
}

/** Append-only audit trail (spec §38). The table rejects UPDATE/DELETE at the database. */
@Injectable()
export class AuditService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async record(input: AuditInput): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorId: input.principal?.userId ?? input.actor?.id ?? null,
        actorType: input.principal || input.actor ? 'USER' : 'SYSTEM',
        actorLabel: input.principal?.email ?? input.actor?.label ?? 'system',
        tenantId: input.tenantId ?? null,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        action: input.action,
        result: input.result ?? 'SUCCESS',
        correlationId: input.correlationId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
        changes: (input.changes ?? undefined) as object | undefined,
      },
    });
  }
}
