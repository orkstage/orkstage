// SPDX-License-Identifier: AGPL-3.0-only
import { createImportSchema, importToTemplateSchema, type ImportDto, type ScanReport } from '@orkstage/contracts';
import type { ImportJob, PrismaClient } from '@orkstage/database';
import { parseTemplate } from '@orkstage/templates';
import { Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { parseDocument } from 'yaml';
import type { z } from 'zod';
import { TemplateValidationService } from '../catalog/template-validation.service.js';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, isPlatformStaff, Scope } from '../common/auth.js';
import { AppError, conflict, notFound, unprocessable } from '../common/errors.js';
import { ApiZodBody, ZodBody } from '../common/validation.js';
import { PRISMA } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';

type Scanner = { scanFiles(files: { path: string; content: string }[], options?: unknown): ScanReport };

/** The Rust scan engine compiled to WebAssembly (@orkstage/scan), loaded on first use. */
let scanner: Promise<Scanner | null> | undefined;
function loadScanner(): Promise<Scanner | null> {
  scanner ??= import('@orkstage/scan' as string).then((m) => (m.default ?? m) as Scanner).catch(() => null);
  return scanner;
}

function toDto(j: ImportJob): ImportDto {
  return {
    id: j.id,
    tenantId: j.tenantId,
    createdAt: j.createdAt.toISOString(),
    sourceKinds: j.sourceKinds,
    report: j.report as unknown as ScanReport,
    validation: j.validation as ImportDto['validation'],
    templateId: j.templateId,
  };
}

/**
 * IaC import (Terraform, CloudFormation, Kubernetes, Compose, ...) → a reviewed draft template.
 * Detection and mapping live in one engine (orkstage-scan) shared with the `ork` CLI; the CLI can
 * also send its own report so private repositories never leave the developer's machine.
 */
@ApiTags('imports')
@Controller('imports')
export class ImportsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly validation: TemplateValidationService,
    private readonly audit: AuditService,
  ) {}

  @Scope('imports:write')
  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiZodBody(createImportSchema)
  async create(
    @CurrentPrincipal() p: RequestPrincipal,
    @ZodBody(createImportSchema) body: z.infer<typeof createImportSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<ImportDto> {
    const tenantId = body.tenantId ?? (isPlatformStaff(p) ? null : p.memberships[0]?.tenantId ?? null);
    authorize(p, 'create', 'Import', { tenantId });

    let report: ScanReport;
    if (body.files) {
      const engine = await loadScanner();
      if (!engine) throw new AppError(501, 'SCANNER_UNAVAILABLE', 'File scanning is not installed on this server. Scan locally with `ork import` and send the report instead.');
      report = engine.scanFiles(body.files);
    } else {
      report = body.report as unknown as ScanReport;
      if (report.version !== 1 || typeof report.template !== 'string' || !Array.isArray(report.resources)) {
        throw unprocessable('INVALID_REPORT', 'The report is not a ScanReport v1.');
      }
    }

    const validation = await this.validation.validate(report.template);
    const organizationId = tenantId
      ? (await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { organizationId: true } })).organizationId
      : (await this.prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { id: true } })).id;
    const job = await this.prisma.importJob.create({
      data: {
        organizationId,
        tenantId,
        createdById: p.userId,
        sourceKinds: [...new Set((report.detectors ?? []).filter((d) => d.files > 0).map((d) => d.kind))],
        report: report as object,
        validation: validation as object,
      },
    });
    await this.audit.record({
      principal: p,
      tenantId,
      resourceType: 'Import',
      resourceId: job.id,
      action: 'CREATE',
      correlationId,
      changes: { resources: report.resources.length, unmapped: report.unmapped?.length ?? 0, valid: validation.valid, via: body.files ? 'files' : 'report' },
    });
    return toDto(job);
  }

  @Scope('imports:write')
  @Get()
  async list(@CurrentPrincipal() p: RequestPrincipal, @Query('tenantId') tenantId?: string): Promise<ImportDto[]> {
    const where = isPlatformStaff(p)
      ? tenantId ? { tenantId } : {}
      : { tenantId: { in: p.memberships.map((m) => m.tenantId) }, ...(tenantId ? { tenantId } : {}) };
    const rows = await this.prisma.importJob.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map(toDto);
  }

  @Scope('imports:write')
  @Get(':id')
  async get(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string): Promise<ImportDto> {
    return toDto(await this.load(p, id));
  }

  /** Turns the generated template into a DRAFT template for review in the builder. */
  @Scope('templates:write')
  @Post(':id/template')
  @ApiZodBody(importToTemplateSchema)
  async toTemplate(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(importToTemplateSchema) body: z.infer<typeof importToTemplateSchema>,
    @CorrelationId() correlationId: string,
  ) {
    const job = await this.load(p, id);
    authorize(p, 'create', 'Template');
    if (job.templateId) throw conflict('ALREADY_CONVERTED', 'This import already produced a template.', { templateId: job.templateId });
    if (await this.prisma.template.findUnique({ where: { name: body.name } })) throw conflict('TEMPLATE_EXISTS', `Template ${body.name} already exists.`);

    // Rename in the YAML document itself so the author's formatting and comments survive.
    const doc = parseDocument((job.report as unknown as ScanReport).template);
    doc.setIn(['metadata', 'name'], body.name);
    doc.setIn(['metadata', 'displayName'], body.displayName);
    doc.setIn(['metadata', 'version'], '0.1.0');
    const source = doc.toString();
    const parsed = parseTemplate(source);
    if (!parsed.ok) throw unprocessable('TEMPLATE_INVALID', 'The imported template is not valid yet. Fix it in the import report and retry.', { issues: parsed.issues });

    const t = await this.prisma.template.create({
      data: {
        name: body.name,
        displayName: body.displayName,
        description: parsed.template.metadata.description || `Imported from ${job.sourceKinds.join(', ')}`,
        createdById: p.userId,
        versions: { create: { version: '0.1.0', source, document: parsed.template as object } },
      },
    });
    await this.prisma.importJob.update({ where: { id }, data: { templateId: t.id } });
    await this.audit.record({ principal: p, tenantId: job.tenantId, resourceType: 'Template', resourceId: t.id, action: 'IMPORT', correlationId, changes: { importId: id, name: t.name } });
    return { templateId: t.id, name: t.name, version: '0.1.0', status: 'DRAFT' };
  }

  private async load(p: RequestPrincipal, id: string) {
    const job = await this.prisma.importJob.findUnique({ where: { id } });
    if (!job) throw notFound('Import');
    if (!isPlatformStaff(p) && !p.memberships.some((m) => m.tenantId === job.tenantId)) throw notFound('Import');
    authorize(p, 'read', 'Import', { tenantId: job.tenantId });
    return job;
  }
}
