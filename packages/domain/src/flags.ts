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
  // What a tenant's templates may use (ADR 0007): on unless turned off for the platform or a tenant.
  { key: 'MULTI_CLOUD', category: 'feature', defaultEnabled: true, description: 'Instances may place resources on more than one provider.' },
  { key: 'MULTI_REGION', category: 'feature', defaultEnabled: true, description: 'Instances may place resources in more than one region.' },
  { key: 'AUTOSCALING', category: 'feature', defaultEnabled: true, description: 'Services may scale their replicas automatically.' },
  { key: 'CUSTOM_DOMAINS', category: 'feature', defaultEnabled: true, description: 'DNS resources may use custom domains besides the platform subdomain.' },
  // Spec §56 switches for features that already exist: on unless turned off for the platform or a tenant.
  { key: 'DRIFT_DETECTION', category: 'feature', defaultEnabled: true, description: 'Scheduled drift scans compare real resources with the applied configuration.' },
  {
    key: 'AUTOMATED_INCIDENTS',
    category: 'feature',
    defaultEnabled: true,
    description: 'Alert rules open incidents on their own. When off, people declare incidents; open ones still resolve and notifications still go out.',
  },
  { key: 'COST_ESTIMATION', category: 'feature', defaultEnabled: true, description: 'Plans, previews, deployments and the overview show an approximate monthly cost.' },
  { key: 'PUBLIC_STATUS_PAGES', category: 'feature', defaultEnabled: true, description: 'Status pages may be public, readable without signing in.' },
];

const BY_KEY = new Map(FEATURE_FLAGS.map((f) => [f.key, f]));

export function isFeatureFlag(key: string): boolean {
  return BY_KEY.has(key);
}

/**
 * Effective value of every flag for one tenant (or the platform when `tenantId` is omitted): the
 * tenant's own override, else the platform override, else the default.
 */
export function resolveFeatureFlags(overrides: readonly FeatureFlagOverride[], tenantId?: string | null): Record<string, boolean> {
  const platform = new Map(overrides.filter((o) => o.tenantId === null).map((o) => [o.key, o.enabled]));
  const tenant = new Map(tenantId ? overrides.filter((o) => o.tenantId === tenantId).map((o) => [o.key, o.enabled]) : []);
  return Object.fromEntries(FEATURE_FLAGS.map((f) => [f.key, tenant.get(f.key) ?? platform.get(f.key) ?? f.defaultEnabled]));
}

/** Flags per tenant from one read of the overrides: a worker tick covers many tenants. */
export function flagsByTenant(overrides: readonly FeatureFlagOverride[]): (tenantId: string | null) => Record<string, boolean> {
  const cache = new Map<string | null, Record<string, boolean>>();
  return (tenantId) => {
    let flags = cache.get(tenantId);
    if (!flags) {
      flags = resolveFeatureFlags(overrides, tenantId);
      cache.set(tenantId, flags);
    }
    return flags;
  };
}

export function isProviderEnabled(flags: Readonly<Record<string, boolean>>, provider: CloudProvider): boolean {
  return flags[providerFlagKey(provider)] ?? PROVIDERS_ON_BY_DEFAULT.has(provider);
}
