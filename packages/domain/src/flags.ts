// SPDX-License-Identifier: AGPL-3.0-only
import { CLOUD_PROVIDERS, PROVIDER_INFO, type CloudProvider } from './providers.js';

export type FeatureFlagCategory = 'provider' | 'feature';

export interface FeatureFlagDefinition {
  key: string;
  category: FeatureFlagCategory;
  description: string;
  /** Value when nobody has set the flag, platform wide or for a tenant. */
  defaultEnabled: boolean;
  provider?: CloudProvider;
}

/** A stored decision: platform wide when `tenantId` is null, otherwise for one tenant. */
export interface FeatureFlagOverride {
  key: string;
  tenantId: string | null;
  enabled: boolean;
}

export const providerFlagKey = (provider: CloudProvider) => `PROVIDER_${provider.toUpperCase()}`;

/**
 * Providers proven end to end. Every other adapter ships disabled until it has been tested on a
 * live account; an administrator turns it on for the whole platform or for one tenant.
 */
const PROVIDERS_ON_BY_DEFAULT: ReadonlySet<CloudProvider> = new Set(['aws', 'mock']);

export const FEATURE_FLAGS: readonly FeatureFlagDefinition[] = [
  ...CLOUD_PROVIDERS.map((provider) => ({
    key: providerFlagKey(provider),
    category: 'provider' as const,
    provider,
    defaultEnabled: PROVIDERS_ON_BY_DEFAULT.has(provider),
    description:
      provider === 'mock'
        ? 'Simulation targets: imitate any provider without an account.'
        : `Register ${PROVIDER_INFO[provider].displayName} targets and deploy resources to them.`,
  })),
  {
    key: 'TEMPLATE_MARKETPLACE',
    category: 'feature',
    defaultEnabled: true,
    description: 'Template marketplace: browse curated and community templates, submit templates for review.',
  },
];

const BY_KEY = new Map(FEATURE_FLAGS.map((f) => [f.key, f]));

export function isFeatureFlag(key: string): boolean {
  return BY_KEY.has(key);
}

/**
 * Effective value of every flag for one tenant (or the platform when `tenantId` is omitted):
 * the tenant's own override, else the platform override, else on when the tenant's plan lists the
 * flag in its `featureFlags` entitlement, else the default. A platform override still wins over
 * the plan, so a platform owner can switch something off for everyone.
 */
export function resolveFeatureFlags(
  overrides: readonly FeatureFlagOverride[],
  tenantId?: string | null,
  planFlags: readonly string[] = [],
): Record<string, boolean> {
  const platform = new Map(overrides.filter((o) => o.tenantId === null).map((o) => [o.key, o.enabled]));
  const tenant = new Map(tenantId ? overrides.filter((o) => o.tenantId === tenantId).map((o) => [o.key, o.enabled]) : []);
  const plan = new Set(planFlags);
  return Object.fromEntries(FEATURE_FLAGS.map((f) => [f.key, tenant.get(f.key) ?? platform.get(f.key) ?? (plan.has(f.key) || f.defaultEnabled)]));
}

export function isProviderEnabled(flags: Readonly<Record<string, boolean>>, provider: CloudProvider): boolean {
  return flags[providerFlagKey(provider)] ?? PROVIDERS_ON_BY_DEFAULT.has(provider);
}
