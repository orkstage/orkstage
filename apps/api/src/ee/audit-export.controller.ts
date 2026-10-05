// SPDX-License-Identifier: LicenseRef-OrkStage-Enterprise
// Copyright OrkStage. Licensed under the OrkStage Enterprise License (see ./LICENSE).
import type { AuditEvent, PrismaClient } from '@co/database';
import { Controller, Get, Inject, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, isPlatformStaff, Scope } from '../common/auth.js';
import { forbidden, unprocessable } from '../common/errors.js';
import { PRISMA } from '../infra/infra.module.js';
import { EnterpriseFeatureGuard, RequiresFeature } from '../licensing/licensing.module.js';
import type { RequestPrincipal } from '../types.js';

const MAX_ROWS = 100_000;
const PAGE = 2_000;
const COLUMNS = ['id', 'at', 'actorType', 'actorLabel', 'tenantId', 'resourceType', 'resourceId', 'action', 'result', 'ip', 'correlationId', 'changes'] as const;

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Quote everything and neutralize spreadsheet formula injection (=, +, -, @ prefixes).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

function row(e: AuditEvent) {
  return { id: String(e.id), at: e.at.toISOString(), actorType: e.actorType, actorLabel: e.actorLabel, tenantId: e.tenantId, resourceType: e.resourceType, resourceId: e.resourceId, action: e.action, result: e.result, ip: e.ip, correlationId: e.correlationId, changes: e.changes };
}

/**
 * Enterprise: audit log export for SIEM ingestion and compliance archives (CSV or NDJSON),
 * streamed in pages so large exports never load fully into memory. The export itself is audited.
 */
@ApiTags('enterprise')
@Controller('audit')
@UseGuards(EnterpriseFeatureGuard)
export class AuditExportController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  @Scope('audit:read')
  @RequiresFeature('audit.export')
  @Get('export')
  async export(
    @CurrentPrincipal() p: RequestPrincipal,
    @Res() reply: FastifyReply,
    @CorrelationId() correlationId: string,
    @Query('format') format = 'ndjson',
    @Query('tenantId') tenantId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (format !== 'ndjson' && format !== 'csv') throw unprocessable('INVALID_FORMAT', 'format must be ndjson or csv.');
    if (tenantId) authorize(p, 'read', 'Audit', { tenantId });
    else if (!isPlatformStaff(p)) throw forbidden('Choose a tenant to export its audit log.');
    const range = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) };
    const where = { ...(tenantId ? { tenantId } : {}), ...(from || to ? { at: range } : {}) };

    await this.audit.record({ principal: p, tenantId: tenantId ?? null, resourceType: 'Audit', action: 'EXPORT', correlationId, changes: { format, from: from ?? null, to: to ?? null } });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    reply.header('content-type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson');
    reply.header('content-disposition', `attachment; filename="orkstage-audit-${stamp}.${format === 'csv' ? 'csv' : 'ndjson'}"`);
    const prisma = this.prisma;
    async function* lines() {
      if (format === 'csv') yield `${COLUMNS.join(',')}\n`;
      let cursor: bigint | undefined;
      let sent = 0;
      while (sent < MAX_ROWS) {
        const rows = await prisma.auditEvent.findMany({ where, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
        if (rows.length === 0) return;
        for (const e of rows) {
          const r = row(e);
          yield format === 'csv' ? `${COLUMNS.map((c) => csvCell(r[c])).join(',')}\n` : `${JSON.stringify(r)}\n`;
        }
        sent += rows.length;
        cursor = rows[rows.length - 1]!.id;
      }
    }
    const { Readable } = await import('node:stream');
    return reply.send(Readable.from(lines()));
  }
}
