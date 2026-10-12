// SPDX-License-Identifier: AGPL-3.0-only
import type { PrismaClient } from '@orkstage/database';
import { entitlementsFor, isProviderEnabled, PROVIDER_INFO, providerFlagKey, resolveFeatureFlags, type CloudProvider } from '@orkstage/domain';
import { Inject, Injectable } from '@nestjs/common';
import { PRISMA } from '../infra/infra.module.js';
import { unprocessable } from './errors.js';

/**
 * Effective feature flags from the FeatureFlag table (platform rows have no tenant). Read per
 * request: the table is tiny and a change must take effect on every API instance at once.
 */
@Injectable()
export class FeatureFlagsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async forTenant(tenantId?: string | null): Promise<Record<string, boolean>> {
    const [rows, tenant] = await Promise.all([
      this.prisma.featureFlag.findMany({ where: tenantId ? { OR: [{ tenantId: null }, { tenantId }] } : { tenantId: null } }),
      tenantId ? this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: { select: { code: true, entitlements: true } } } }) : null,
    ]);
    const planFlags = tenant ? entitlementsFor(tenant.plan.code, tenant.plan.entitlements).featureFlags : [];
    return resolveFeatureFlags(rows, tenantId ?? null, planFlags);
  }

  async providerCheck(tenantId?: string | null): Promise<(provider: CloudProvider) => boolean> {
    const flags = await this.forTenant(tenantId);
    return (provider) => isProviderEnabled(flags, provider);
  }

  /** Refuses work on a provider that is switched off for this tenant (or the platform). */
  async assertProvider(provider: CloudProvider, tenantId?: string | null): Promise<void> {
    if ((await this.providerCheck(tenantId))(provider)) return;
    throw unprocessable(
      'PROVIDER_DISABLED',
      `${PROVIDER_INFO[provider].displayName} is disabled on this platform. A platform owner can enable it with the ${providerFlagKey(provider)} feature flag.`,
      { provider, flag: providerFlagKey(provider) },
    );
  }
}
