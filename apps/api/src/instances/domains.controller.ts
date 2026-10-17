// SPDX-License-Identifier: AGPL-3.0-only
import { addDomainSchema, type DomainDto } from '@orkstage/contracts';
import type { Domain, InstanceResource, PrismaClient } from '@orkstage/database';
import { domainRecords, isWithinZone, readTenantLimits, tenantFeatures } from '@orkstage/domain';
import { environmentTemplate } from '@orkstage/templates';
import { Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, Scope, tenantScope } from '../common/auth.js';
import { conflict, notFound, unprocessable } from '../common/errors.js';
import { FeatureFlagsService } from '../common/feature-flags.service.js';
import { iso } from '../common/pagination.js';
import { ApiZodBody, ZodBody } from '../common/validation.js';
import { PRISMA } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';

const SERVING_TYPES = ['dns', 'web.frontend'];

const list = (v: unknown) => (typeof v === 'string' && v ? v.split(',') : []);

/** Where the owner points the hostname: the platform subdomain, or the frontend's own host. */
function routeTarget(r: InstanceResource | undefined): string | null {
  const out = (r?.outputs ?? {}) as Record<string, unknown>;
  if (r?.type === 'dns' && out.fqdn) return String(out.fqdn);
  if (r?.type === 'web.frontend' && out.url) return String(out.url).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return null;
}

/** A verified hostname the applied resource does not serve yet, or whose new certificate is not attached. */
function needsDeploy(d: Domain, r: InstanceResource | undefined): boolean {
  if (d.kind !== 'CUSTOM' || d.status !== 'VERIFIED' || !r) return false;
  const out = (r.outputs ?? {}) as Record<string, unknown>;
  if (r.type === 'dns') {
    if (!list(out.custom_domains).includes(d.hostname)) return true;
    return (d.certificateStatus === 'ISSUED' || d.certificateStatus === 'EXPIRING') && out.custom_certificate_attached === 'false';
  }
  return typeof out.domains === 'string' && !list(out.domains).includes(d.hostname);
}

function toDto(d: Domain, r: InstanceResource | undefined): DomainDto {
  return {
    id: d.id,
    instanceId: d.instanceId,
    resourceId: d.resourceId,
    hostname: d.hostname,
    kind: d.kind,
    status: d.status,
    verifiedAt: iso(d.verifiedAt),
    lastCheckedAt: iso(d.lastCheckedAt),
    lastError: d.lastError,
    certificateStatus: d.certificateStatus,
    certificateExpiresAt: iso(d.certificateExpiresAt),
    records: domainRecords(d, routeTarget(r)),
    needsDeploy: needsDeploy(d, r),
    createdAt: d.createdAt.toISOString(),
  };
}

/**
 * Custom domains of an instance (spec §23, open item 9). Adding one returns the DNS records its
 * owner creates: a TXT record proves ownership, a CNAME routes traffic. The worker verifies it,
 * the next deployment attaches it and requests its certificate, and the worker watches the
 * certificate until it expires. A hostname belongs to one instance on the whole platform.
 */
@ApiTags('instances')
@Controller()
export class DomainsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly flags: FeatureFlagsService,
    private readonly audit: AuditService,
  ) {}

  @Scope('instances:read')
  @Get('instances/:id/domains')
  async list(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string): Promise<DomainDto[]> {
    const instance = await this.instanceFor(p, id, 'read');
    const [domains, resources] = await Promise.all([
      this.prisma.domain.findMany({ where: { instanceId: id }, orderBy: [{ kind: 'asc' }, { hostname: 'asc' }] }),
      this.prisma.instanceResource.findMany({ where: { instanceId: instance.id, type: { in: SERVING_TYPES } } }),
    ]);
    return domains.map((d) => toDto(d, resources.find((r) => r.resourceId === d.resourceId)));
  }

  @Scope('instances:write')
  @Post('instances/:id/domains')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiZodBody(addDomainSchema)
  async add(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(addDomainSchema) body: z.infer<typeof addDomainSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<DomainDto> {
    const instance = await this.instanceFor(p, id, 'update');
    const [tenant, flags, version, resources, count] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({ where: { id: instance.tenantId } }),
      this.flags.forTenant(instance.tenantId),
      this.prisma.templateVersion.findUniqueOrThrow({ where: { id: instance.templateVersionId } }),
      this.prisma.instanceResource.findMany({ where: { instanceId: id, type: { in: SERVING_TYPES } } }),
      this.prisma.domain.count({ where: { instanceId: id, kind: 'CUSTOM' } }),
    ]);
    if (!tenantFeatures(flags).customDomains) throw unprocessable('CUSTOM_DOMAINS_DISABLED', 'Custom domains are not enabled for this tenant.');
    const limit = readTenantLimits(tenant.limits).maxDomainsPerInstance;
    if (limit !== undefined && count >= limit) throw unprocessable('LIMIT_MAX_DOMAINS', `This tenant allows ${limit} custom domains per instance.`, { limit });

    // The template decides which resources may serve a custom domain.
    const template = environmentTemplate.parse(version.document);
    const eligible = template.spec.resources.filter((r) => (r.type === 'dns' && r.customDomain !== 'disabled') || r.type === 'web.frontend');
    const chosen = body.resourceId ? eligible.find((r) => r.id === body.resourceId) : eligible.length === 1 ? eligible[0] : undefined;
    if (!chosen) {
      throw unprocessable(
        'NO_DOMAIN_RESOURCE',
        eligible.length === 0
          ? 'The template of this instance has no resource that serves a custom domain (a dns resource with customDomain enabled, or a web frontend).'
          : `Choose the resource that serves it: ${eligible.map((r) => r.id).join(', ')}.`,
      );
    }
    const serving = resources.find((r) => r.resourceId === chosen.id);
    const platform = serving?.type === 'dns' ? String((serving.outputs as Record<string, unknown>)?.fqdn ?? '') : '';
    const zone = platform.split('.').slice(1).join('.');
    if (zone && isWithinZone(body.hostname, zone)) throw unprocessable('DOMAIN_IN_PLATFORM_ZONE', `Hostnames under ${zone} belong to the platform.`);

    let taken = await this.prisma.domain.findUnique({ where: { hostname: body.hostname }, select: { id: true, instanceId: true, status: true } });
    // A claim that failed verification does not hold the hostname: someone who owns it may take it.
    if (taken?.status === 'FAILED' && taken.instanceId !== id) {
      await this.prisma.domain.delete({ where: { id: taken.id } });
      taken = null;
    }
    // Another tenant's hostname is reported without saying whose it is.
    if (taken) throw conflict('DOMAIN_TAKEN', taken.instanceId === id ? 'This instance already has this hostname.' : 'This hostname is already attached to another instance.');

    const row = await this.prisma.domain
      .create({
        data: { tenantId: instance.tenantId, instanceId: id, resourceId: chosen.id, hostname: body.hostname, kind: 'CUSTOM', verificationToken: `orkstage-verify=${randomBytes(18).toString('base64url')}` },
      })
      .catch((err: { code?: string }) => {
        if (err.code === 'P2002') throw conflict('DOMAIN_TAKEN', 'This hostname is already attached to another instance.');
        throw err;
      });
    await this.audit.record({ principal: p, tenantId: instance.tenantId, resourceType: 'Domain', resourceId: row.id, action: 'CREATE', correlationId, changes: { hostname: row.hostname, instanceId: id } });
    return toDto(row, serving);
  }

  /** Looks up the TXT record on the next worker tick instead of waiting a minute; a failed domain gets another 7 days. */
  @Scope('instances:write')
  @Post('domains/:id/verify')
  @HttpCode(202)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async verify(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string): Promise<DomainDto> {
    const d = await this.domainFor(p, id);
    if (d.kind !== 'CUSTOM') throw unprocessable('DOMAIN_PLATFORM', 'The platform subdomain needs no verification.');
    const updated = await this.prisma.domain.update({
      where: { id },
      data: { lastCheckedAt: null, ...(d.status === 'FAILED' ? { status: 'PENDING_VERIFICATION', createdAt: new Date() } : {}) },
    });
    const r = await this.prisma.instanceResource.findFirst({ where: { instanceId: d.instanceId, resourceId: d.resourceId } });
    return toDto(updated, r ?? undefined);
  }

  /** Removes a custom domain; the next deployment detaches it and its certificate. */
  @Scope('instances:write')
  @Delete('domains/:id')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string, @CorrelationId() correlationId: string) {
    const d = await this.domainFor(p, id);
    if (d.kind !== 'CUSTOM') throw unprocessable('DOMAIN_PLATFORM', 'The platform subdomain goes away with its dns resource.');
    await this.prisma.domain.delete({ where: { id } });
    await this.audit.record({ principal: p, tenantId: d.tenantId, resourceType: 'Domain', resourceId: id, action: 'DELETE', correlationId, changes: { hostname: d.hostname } });
  }

  private async instanceFor(p: RequestPrincipal, id: string, action: 'read' | 'update') {
    const instance = await this.prisma.instance.findFirst({ where: { id, ...tenantScope(p) } });
    if (!instance) throw notFound('Instance');
    authorize(p, action, 'Instance', { tenantId: instance.tenantId });
    return instance;
  }

  private async domainFor(p: RequestPrincipal, id: string): Promise<Domain> {
    const d = await this.prisma.domain.findFirst({ where: { id, ...tenantScope(p) } });
    if (!d) throw notFound('Domain');
    authorize(p, 'update', 'Instance', { tenantId: d.tenantId });
    return d;
  }
}
