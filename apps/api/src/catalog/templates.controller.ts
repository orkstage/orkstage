// SPDX-License-Identifier: AGPL-3.0-only
import {
  cloneTemplateSchema,
  createTemplateSchema,
  deprecateVersionSchema,
  updateDraftSchema,
  validateTemplateSchema,
  type TemplateDto,
  type TemplateVersionDto,
} from '@orkstage/contracts';
import { Prisma, type PrismaClient, type TemplateVersion } from '@orkstage/database';
import { parseTemplate, type EnvironmentTemplate } from '@orkstage/templates';
import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { stringify } from 'yaml';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, Scope } from '../common/auth.js';
import { conflict, notFound, unprocessable } from '../common/errors.js';
import { iso } from '../common/pagination.js';
import { ApiZodBody, ZodBody } from '../common/validation.js';
import { PRISMA } from '../infra/infra.module.js';
import { TemplateValidationService } from './template-validation.service.js';
import type { RequestPrincipal } from '../types.js';

const semverGt = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i]! !== pb[i]!) return pa[i]! > pb[i]!;
  return false;
};

/**
 * Templates are versioned and immutable once published (spec §7, §71). Publishing runs the full
 * pipeline — schema, semantic, plan, provider capability and security policy — against every
 * plan the template claims to support, so an unsafe template cannot be published (spec §19).
 */
@ApiTags('templates')
@Controller('templates')
export class TemplatesController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly validation: TemplateValidationService,
    private readonly audit: AuditService,
  ) {}

  @Scope('templates:read')
  @Get()
  async list(@CurrentPrincipal() p: RequestPrincipal): Promise<TemplateDto[]> {
    authorize(p, 'read', 'Template');
    const templates = await this.prisma.template.findMany({
      include: { versions: { where: { status: 'PUBLISHED' }, orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { name: 'asc' },
    });
    return templates.map((t) => ({
      id: t.id,
      name: t.name,
      displayName: t.displayName,
      description: t.description,
      visibility: t.visibility,
      latestPublished: t.versions[0] ? this.versionDto(t.versions[0]) : null,
    }));
  }

  @Scope('templates:read')
  @Get(':id')
  async get(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string): Promise<TemplateDto> {
    authorize(p, 'read', 'Template');
    const t = await this.prisma.template.findUnique({
      where: { id },
      include: { versions: { orderBy: { createdAt: 'desc' }, include: { _count: { select: { instances: true } } } } },
    });
    if (!t) throw notFound('Template');
    const published = t.versions.find((v) => v.status === 'PUBLISHED');
    return {
      id: t.id,
      name: t.name,
      displayName: t.displayName,
      description: t.description,
      visibility: t.visibility,
      latestPublished: published ? this.versionDto(published) : null,
      versions: t.versions.map((v) => ({ ...this.versionDto(v), instanceCount: v._count.instances })),
    };
  }

  @Scope('templates:write')
  @Post()
  @ApiZodBody(createTemplateSchema)
  async create(
    @CurrentPrincipal() p: RequestPrincipal,
    @ZodBody(createTemplateSchema) body: z.infer<typeof createTemplateSchema>,
    @CorrelationId() correlationId: string,
  ) {
    authorize(p, 'create', 'Template');
    const template = this.parseOrThrow(body.source);
    const exists = await this.prisma.template.findUnique({ where: { name: template.metadata.name } });
    if (exists) throw conflict('TEMPLATE_EXISTS', `Template ${template.metadata.name} already exists; add a version instead.`);
    const t = await this.prisma.template.create({
      data: {
        name: template.metadata.name,
        displayName: template.metadata.displayName,
        description: template.metadata.description,
        createdById: p.userId,
        versions: { create: { version: template.metadata.version, source: body.source, document: template as object } },
      },
    });
    await this.audit.record({ principal: p, resourceType: 'Template', resourceId: t.id, action: 'CREATE', correlationId, changes: { name: t.name, version: template.metadata.version } });
    return this.get(p, t.id);
  }

  @Scope('templates:write')
  @Post(':id/versions')
  @ApiZodBody(createTemplateSchema)
  async addVersion(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(createTemplateSchema) body: z.infer<typeof createTemplateSchema>,
    @CorrelationId() correlationId: string,
  ) {
    authorize(p, 'update', 'Template');
    const t = await this.prisma.template.findUnique({ where: { id }, include: { versions: true } });
    if (!t) throw notFound('Template');
    if (t.visibility === 'SYSTEM') throw unprocessable('SYSTEM_TEMPLATE', 'System templates are read-only. Clone it to customize.');
    const template = this.parseOrThrow(body.source);
    if (template.metadata.name !== t.name) throw unprocessable('NAME_MISMATCH', `metadata.name must stay "${t.name}".`);
    const latest = t.versions.map((v) => v.version).sort((a, b) => (semverGt(a, b) ? -1 : 1))[0];
    if (latest && !semverGt(template.metadata.version, latest)) {
      throw unprocessable('VERSION_NOT_INCREASED', `New version must be greater than ${latest}.`);
    }
    const v = await this.prisma.templateVersion.create({
      data: { templateId: id, version: template.metadata.version, source: body.source, document: template as object },
    });
    await this.audit.record({ principal: p, resourceType: 'TemplateVersion', resourceId: v.id, action: 'CREATE', correlationId, changes: { template: t.name, version: v.version } });
    return this.versionDto(v);
  }

  /** Replaces the source of a draft (open item 13). Published and deprecated versions never change. */
  @Scope('templates:write')
  @Put(':id/versions/:versionId')
  @ApiZodBody(updateDraftSchema)
  async updateDraft(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @ZodBody(updateDraftSchema) body: z.infer<typeof updateDraftSchema>,
    @CorrelationId() correlationId: string,
  ) {
    authorize(p, 'update', 'Template');
    const t = await this.prisma.template.findUnique({ where: { id } });
    if (!t) throw notFound('Template');
    if (t.visibility === 'SYSTEM') throw unprocessable('SYSTEM_TEMPLATE', 'System templates are read-only. Clone it to customize.');
    const v = await this.prisma.templateVersion.findFirst({ where: { id: versionId, templateId: id } });
    if (!v) throw notFound('Template version');
    if (v.status !== 'DRAFT') throw conflict('VERSION_NOT_DRAFT', `Version ${v.version} is ${v.status.toLowerCase()} and cannot change. Add a new version instead.`);
    const template = this.parseOrThrow(body.source);
    if (template.metadata.name !== t.name) throw unprocessable('NAME_MISMATCH', `metadata.name must stay "${t.name}".`);
    if (template.metadata.version !== v.version) throw unprocessable('VERSION_MISMATCH', `metadata.version must stay ${v.version} in this draft. Add a new version to change it.`);
    const updated = await this.prisma.templateVersion.update({ where: { id: v.id }, data: { source: body.source, document: template as object, validation: Prisma.DbNull } });
    await this.audit.record({ principal: p, resourceType: 'TemplateVersion', resourceId: v.id, action: 'UPDATE', correlationId, changes: { template: t.name, version: v.version } });
    return this.versionDto(updated);
  }

  /** Instances on a deprecated version keep running; new instances and upgrades cannot use it. */
  @Scope('templates:write')
  @Post(':id/versions/:versionId/deprecate')
  @HttpCode(200)
  @ApiZodBody(deprecateVersionSchema)
  async deprecate(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @ZodBody(deprecateVersionSchema) body: z.infer<typeof deprecateVersionSchema>,
    @CorrelationId() correlationId: string,
  ) {
    authorize(p, 'publish', 'Template');
    const v = await this.prisma.templateVersion.findFirst({ where: { id: versionId, templateId: id } });
    if (!v) throw notFound('Template version');
    if (v.status !== 'PUBLISHED') throw conflict('VERSION_NOT_PUBLISHED', 'Only published versions can be deprecated.');
    const updated = await this.prisma.templateVersion.update({ where: { id: v.id }, data: { status: 'DEPRECATED', deprecatedAt: new Date(), deprecationNote: body.note ?? null } });
    const running = await this.prisma.instance.count({ where: { templateVersionId: v.id, status: { not: 'DESTROYED' } } });
    await this.audit.record({ principal: p, resourceType: 'TemplateVersion', resourceId: v.id, action: 'DEPRECATE', correlationId, changes: { version: v.version, note: body.note ?? null, instances: running } });
    return { ...this.versionDto(updated), instanceCount: running };
  }

  @Scope('templates:write')
  @Post(':id/versions/:versionId/restore')
  @HttpCode(200)
  async restore(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string, @CorrelationId() correlationId: string) {
    authorize(p, 'publish', 'Template');
    const v = await this.prisma.templateVersion.findFirst({ where: { id: versionId, templateId: id } });
    if (!v) throw notFound('Template version');
    if (v.status !== 'DEPRECATED') throw conflict('VERSION_NOT_DEPRECATED', 'Only deprecated versions can be restored.');
    const updated = await this.prisma.templateVersion.update({ where: { id: v.id }, data: { status: 'PUBLISHED', deprecatedAt: null, deprecationNote: null } });
    await this.audit.record({ principal: p, resourceType: 'TemplateVersion', resourceId: v.id, action: 'RESTORE', correlationId, changes: { version: v.version } });
    return this.versionDto(updated);
  }

  @Scope('templates:read')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':id/validate')
  @HttpCode(200)
  @ApiZodBody(validateTemplateSchema)
  async validate(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(validateTemplateSchema) body: z.infer<typeof validateTemplateSchema>,
  ) {
    authorize(p, 'read', 'Template');
    let source = body.source;
    if (!source) {
      const latest = await this.prisma.templateVersion.findFirst({ where: { templateId: id }, orderBy: { createdAt: 'desc' } });
      if (!latest) throw notFound('Template version');
      source = latest.source;
    }
    if (body.tenantId) authorize(p, 'read', 'Tenant', { tenantId: body.tenantId });
    return this.fullValidation(source, body.tenantId);
  }

  @Scope('templates:write')
  @Post(':id/versions/:versionId/publish')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async publish(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @CorrelationId() correlationId: string,
  ) {
    authorize(p, 'publish', 'Template');
    const v = await this.prisma.templateVersion.findFirst({ where: { id: versionId, templateId: id } });
    if (!v) throw notFound('Template version');
    if (v.status !== 'DRAFT') throw conflict('ALREADY_PUBLISHED', 'Only draft versions can be published.');
    const result = await this.fullValidation(v.source);
    // A version nobody could compile against a real catalog is not published blind.
    if (result.issues.some((i) => i.code === 'NO_TARGET_FOR_SLOT')) {
      await this.audit.record({ principal: p, resourceType: 'TemplateVersion', resourceId: v.id, action: 'PUBLISH', result: 'DENIED', correlationId, changes: { reason: 'capability checks did not run' } });
      throw unprocessable(
        'CAPABILITY_UNCHECKED',
        'No shared cloud target can host every placement slot, so the capability and policy checks could not run. Add a target for the providers the slots allow, or widen the slots, and publish again.',
        { issues: result.issues },
      );
    }
    if (!result.valid) {
      await this.audit.record({ principal: p, resourceType: 'TemplateVersion', resourceId: v.id, action: 'PUBLISH', result: 'DENIED', correlationId, changes: { issues: result.issues.length } });
      throw unprocessable('TEMPLATE_INVALID', 'The template did not pass validation and cannot be published.', { issues: result.issues });
    }
    const published = await this.prisma.templateVersion.update({
      where: { id: v.id },
      data: { status: 'PUBLISHED', publishedAt: new Date(), publishedById: p.userId, validation: result as object },
    });
    await this.audit.record({ principal: p, resourceType: 'TemplateVersion', resourceId: v.id, action: 'PUBLISH', correlationId, changes: { version: v.version } });
    return this.versionDto(published);
  }

  @Scope('templates:write')
  @Post(':id/clone')
  @ApiZodBody(cloneTemplateSchema)
  async clone(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(cloneTemplateSchema) body: z.infer<typeof cloneTemplateSchema>,
    @CorrelationId() correlationId: string,
  ) {
    authorize(p, 'create', 'Template');
    const source = await this.prisma.templateVersion.findFirst({ where: { templateId: id }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }] });
    if (!source) throw notFound('Template');
    const doc = structuredClone(source.document) as EnvironmentTemplate;
    doc.metadata = { ...doc.metadata, name: body.name, displayName: body.displayName, version: '1.0.0' };
    const yaml = stringify(doc);
    const t = await this.prisma.template.create({
      data: {
        name: body.name,
        displayName: body.displayName,
        description: doc.metadata.description,
        createdById: p.userId,
        versions: { create: { version: '1.0.0', source: yaml, document: doc as object } },
      },
    });
    await this.audit.record({ principal: p, resourceType: 'Template', resourceId: t.id, action: 'CLONE', correlationId, changes: { from: id, name: body.name } });
    return this.get(p, t.id);
  }

  private parseOrThrow(source: string): EnvironmentTemplate {
    const parsed = parseTemplate(source);
    if (!parsed.ok) throw unprocessable('TEMPLATE_INVALID', 'The template is not valid.', { issues: parsed.issues });
    return parsed.template;
  }

  private fullValidation(source: string, tenantId?: string) {
    return this.validation.validate(source, tenantId);
  }

  private versionDto(v: TemplateVersion): TemplateVersionDto {
    return {
      id: v.id,
      version: v.version,
      status: v.status,
      source: v.source,
      document: v.document as Record<string, unknown>,
      validation: (v.validation ?? null) as TemplateVersionDto['validation'],
      publishedAt: iso(v.publishedAt),
      deprecatedAt: iso(v.deprecatedAt),
      deprecationNote: v.deprecationNote,
      createdAt: v.createdAt.toISOString(),
    };
  }
}
