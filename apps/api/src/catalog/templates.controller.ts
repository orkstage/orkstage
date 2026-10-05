import {
  cloneTemplateSchema,
  createTemplateSchema,
  validateTemplateSchema,
  type TemplateDto,
  type TemplateVersionDto,
  type ValidationIssueDto,
} from '@co/contracts';
import type { PrismaClient, TemplateVersion } from '@co/database';
import type { Entitlements, PlanCode } from '@co/domain';
import { compileInfrastructure } from '@co/provisioning';
import { toCloudTarget } from '@co/runtime';
import { parseTemplate, validateTemplate, type EnvironmentTemplate } from '@co/templates';
import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { stringify } from 'yaml';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal } from '../common/auth.js';
import { conflict, notFound, unprocessable } from '../common/errors.js';
import { iso } from '../common/pagination.js';
import { ApiZodBody, ZodBody } from '../common/validation.js';
import { Adapters, PRISMA } from '../infra/infra.module.js';
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
    private readonly adapters: Adapters,
    private readonly audit: AuditService,
  ) {}

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
    return this.fullValidation(source, body.planCode ? [body.planCode] : undefined);
  }

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

  /**
   * Schema → semantic → plan compatibility for each declared plan → capability + security
   * policy, by compiling against every active cloud target allowed for each slot.
   */
  private async fullValidation(source: string, plansFilter?: PlanCode[]): Promise<{ valid: boolean; issues: ValidationIssueDto[] }> {
    const base = validateTemplate(source);
    if (!base.valid || !base.template) return { valid: false, issues: base.issues };
    const template = base.template;
    const issues: ValidationIssueDto[] = [...base.issues];

    const plans = await this.prisma.plan.findMany({ where: { code: { in: plansFilter ?? template.spec.plans } } });
    const targets = await this.prisma.cloudTarget.findMany({ where: { status: 'ACTIVE', tenantId: null } });

    for (const plan of plans) {
      const entitlements = plan.entitlements as unknown as Entitlements;
      const planReport = validateTemplate(template, { code: plan.code as PlanCode, entitlements });
      issues.push(...planReport.issues.filter((i) => i.stage === 'plan').map((i) => ({ ...i, message: `[${plan.code}] ${i.message}` })));

      // Provider/capability/policy: compile with the first compatible target for each slot.
      const bindings: Record<string, { target: ReturnType<typeof toCloudTarget>; region: string }> = {};
      for (const slot of template.spec.placements) {
        const t = targets.find((x) => slot.providers.length === 0 || slot.providers.includes(x.provider));
        if (t) bindings[slot.name] = { target: toCloudTarget(t), region: t.defaultRegion };
      }
      if (Object.keys(bindings).length < template.spec.placements.length) {
        issues.push({ stage: 'capability', severity: 'warning', code: 'NO_TARGET_FOR_SLOT', message: 'No shared cloud target is compatible with every placement slot; capability checks were partial.' });
        continue;
      }
      const resolved = compileInfrastructure(
        {
          template,
          plan: { code: plan.code as PlanCode, entitlements },
          organizationId: 'validation',
          tenant: { id: 'validation', slug: 'validation' },
          instance: { id: 'validation', slug: 'validation', environment: template.metadata.nonProduction ? 'sandbox' : 'production' },
          bindings,
        },
        this.adapters.registry,
      );
      issues.push(
        ...resolved.issues
          .filter((i) => i.stage === 'capability' || i.stage === 'policy')
          .map((i) => ({ ...i, message: `[${plan.code}] ${i.message}` })),
      );
    }
    const unique = [...new Map(issues.map((i) => [`${i.code}:${i.message}`, i])).values()];
    return { valid: !unique.some((i) => i.severity === 'error'), issues: unique };
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
      createdAt: v.createdAt.toISOString(),
    };
  }
}
