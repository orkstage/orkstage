// SPDX-License-Identifier: AGPL-3.0-only
import { subject } from '@orkstage/authorization';
import { createProfileSchema, setDefaultProfileSchema, updateProfileSchema, type ProfileDto } from '@orkstage/contracts';
import type { Prisma, PrismaClient } from '@orkstage/database';
import { Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, isPlatformStaff, Scope } from '../common/auth.js';
import { conflict, notFound, unprocessable } from '../common/errors.js';
import { ApiZodBody, ZodBody } from '../common/validation.js';
import { PRISMA } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';

const include = { targets: { include: { target: true }, orderBy: { provider: 'asc' } }, _count: { select: { instances: true } } } as const;
type ProfileRow = Prisma.ProfileGetPayload<{ include: typeof include }>;

/**
 * Profiles (ADR 0007): named setups for an environment with the cloud target, and optionally the
 * region, per provider. Platform owners and admins manage them, shared (no tenant) or per tenant;
 * tenant members read theirs and the shared ones. A new instance binds the slots it leaves unbound
 * from a profile.
 */
@ApiTags('profiles')
@Controller('profiles')
export class ProfilesController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  /** Shared profiles and those of the tenants the caller belongs to (staff: every tenant), or of one tenant. */
  @Scope('instances:read')
  @Get()
  async list(@CurrentPrincipal() p: RequestPrincipal, @Query('tenantId') tenantId?: string): Promise<ProfileDto[]> {
    const tenants = isPlatformStaff(p) ? undefined : p.memberships.map((m) => m.tenantId);
    if (tenantId && tenants && !tenants.includes(tenantId)) return [];
    const scope = tenantId ? [tenantId] : tenants;
    const rows = await this.prisma.profile.findMany({
      where: scope ? { OR: [{ tenantId: null }, { tenantId: { in: scope } }] } : {},
      include,
      orderBy: [{ environment: 'asc' }, { name: 'asc' }],
    });
    return rows.map((r) => this.toDto(r));
  }

  @Scope('instances:read')
  @Get(':id')
  async get(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string): Promise<ProfileDto> {
    return this.toDto(await this.load(p, id, 'read'));
  }

  @Post()
  @ApiZodBody(createProfileSchema)
  async create(
    @CurrentPrincipal() p: RequestPrincipal,
    @ZodBody(createProfileSchema) body: z.infer<typeof createProfileSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<ProfileDto> {
    const tenantId = body.tenantId ?? null;
    authorize(p, 'create', 'Profile', { tenantId });
    await this.assertNameFree(tenantId, body.name);
    const targets = await this.checkTargets(tenantId, body.environment, body.targets);
    const row = await this.prisma.$transaction(async (tx) => {
      if (body.isDefault) await tx.profile.updateMany({ where: { tenantId, environment: body.environment, isDefault: true }, data: { isDefault: false } });
      return tx.profile.create({
        data: { tenantId, name: body.name, environment: body.environment, isDefault: body.isDefault, targets: { create: targets } },
        include,
      });
    });
    await this.audit.record({ principal: p, tenantId, resourceType: 'Profile', resourceId: row.id, action: 'CREATE', correlationId, changes: body });
    return this.toDto(row);
  }

  @Patch(':id')
  @ApiZodBody(updateProfileSchema)
  async update(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(updateProfileSchema) body: z.infer<typeof updateProfileSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<ProfileDto> {
    const current = await this.load(p, id, 'update');
    if (body.name && body.name.toLowerCase() !== current.name.toLowerCase()) await this.assertNameFree(current.tenantId, body.name);
    const environment = body.environment ?? current.environment;
    const targets = await this.checkTargets(
      current.tenantId,
      environment,
      body.targets ?? current.targets.map((t) => ({ targetId: t.targetId, region: t.region ?? undefined })),
    );
    const row = await this.prisma.$transaction(async (tx) => {
      // Changing the environment of a default would leave two defaults for the new one.
      const isDefault = current.isDefault && environment === current.environment;
      await tx.profileTarget.deleteMany({ where: { profileId: id } });
      return tx.profile.update({
        where: { id },
        data: { name: body.name, environment, isDefault, targets: { create: targets } },
        include,
      });
    });
    await this.audit.record({ principal: p, tenantId: row.tenantId, resourceType: 'Profile', resourceId: id, action: 'UPDATE', correlationId, changes: body });
    return this.toDto(row);
  }

  /** Instances created from the profile keep their bindings; they only lose the reference. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string, @CorrelationId() correlationId: string): Promise<void> {
    const current = await this.load(p, id, 'delete');
    await this.prisma.profile.delete({ where: { id } });
    await this.audit.record({ principal: p, tenantId: current.tenantId, resourceType: 'Profile', resourceId: id, action: 'DELETE', correlationId, changes: { name: current.name } });
  }

  /** Makes a profile the default of its tenant scope and environment (or stops it being one). */
  @Post(':id/default')
  @HttpCode(200)
  @ApiZodBody(setDefaultProfileSchema)
  async setDefault(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(setDefaultProfileSchema) body: z.infer<typeof setDefaultProfileSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<ProfileDto> {
    const current = await this.load(p, id, 'update');
    const row = await this.prisma.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.profile.updateMany({ where: { tenantId: current.tenantId, environment: current.environment, isDefault: true, id: { not: id } }, data: { isDefault: false } });
      }
      return tx.profile.update({ where: { id }, data: { isDefault: body.isDefault }, include });
    });
    await this.audit.record({ principal: p, tenantId: row.tenantId, resourceType: 'Profile', resourceId: id, action: body.isDefault ? 'SET_DEFAULT' : 'UNSET_DEFAULT', correlationId, changes: { environment: row.environment } });
    return this.toDto(row);
  }

  private async load(p: RequestPrincipal, id: string, action: 'read' | 'update' | 'delete'): Promise<ProfileRow> {
    const row = await this.prisma.profile.findUnique({ where: { id }, include });
    // Another tenant's profile answers 404, like every other tenant record.
    if (!row || !p.ability.can('read', subject('Profile', { tenantId: row.tenantId }))) throw notFound('Profile');
    authorize(p, action, 'Profile', { tenantId: row.tenantId });
    return row;
  }

  private async assertNameFree(tenantId: string | null, name: string): Promise<void> {
    const clash = await this.prisma.profile.findFirst({ where: { tenantId, name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
    if (clash) throw conflict('PROFILE_NAME_TAKEN', `A profile named "${name}" already exists here.`);
  }

  /**
   * One target per provider, each usable in the profile's scope (a shared profile only uses shared
   * targets; a tenant's profile uses shared targets and the tenant's own), serving its environment,
   * with a region it allows.
   */
  private async checkTargets(tenantId: string | null, environment: string, entries: readonly { targetId: string; region?: string }[]) {
    const rows = await this.prisma.cloudTarget.findMany({ where: { id: { in: entries.map((e) => e.targetId) } } });
    const seen = new Set<string>();
    return entries.map((e) => {
      const t = rows.find((r) => r.id === e.targetId);
      if (!t || (t.tenantId !== null && t.tenantId !== tenantId)) throw unprocessable('UNKNOWN_TARGET', 'A cloud target of the profile does not exist or is not available here.', { targetId: e.targetId });
      if (seen.has(t.provider)) throw unprocessable('DUPLICATE_PROVIDER', `A profile has one target per provider; ${t.provider} appears twice.`, { provider: t.provider });
      seen.add(t.provider);
      if (t.environment !== 'any' && t.environment !== environment) {
        throw unprocessable('TARGET_ENVIRONMENT', `Cloud target ${t.name} serves ${t.environment}, and the profile is for ${environment}.`, { targetId: t.id });
      }
      if (e.region && !t.allowedRegions.includes(e.region)) {
        throw unprocessable('INVALID_REGION', `${e.region} is not an allowed region of ${t.name}.`, { targetId: t.id, allowed: t.allowedRegions });
      }
      return { provider: t.provider, targetId: t.id, region: e.region ?? null };
    });
  }

  private toDto(r: ProfileRow): ProfileDto {
    return {
      id: r.id,
      tenantId: r.tenantId,
      name: r.name,
      environment: r.environment,
      isDefault: r.isDefault,
      targets: r.targets.map((t) => ({ provider: t.provider, targetId: t.targetId, targetName: t.target.name, region: t.region, defaultRegion: t.target.defaultRegion })),
      instanceCount: r._count.instances,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
