/**
 * Providers known to the platform. Infrastructure clouds are provisioned with OpenTofu modules;
 * application platforms (Vercel, Render, Supabase) are driven through their own APIs. `mock` is a
 * deterministic simulation provider used for local development and tests; it never touches a
 * real cloud.
 */
export const CLOUD_PROVIDERS = [
  'aws',
  'azure',
  'gcp',
  'oci',
  'digitalocean',
  'vultr',
  'coreweave',
  'magalu',
  'vercel',
  'render',
  'supabase',
  'mock',
] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

/** `infrastructure`: networks, compute and data services. `platform`: a managed application platform. */
export type ProviderKind = 'infrastructure' | 'platform' | 'simulation';

export interface ProviderInfo {
  displayName: string;
  kind: ProviderKind;
  /** What one cloud target is on this provider (shown in forms and docs). */
  targetUnit: string;
}

export const PROVIDER_INFO: Record<CloudProvider, ProviderInfo> = {
  aws: { displayName: 'Amazon Web Services', kind: 'infrastructure', targetUnit: 'AWS account' },
  azure: { displayName: 'Microsoft Azure', kind: 'infrastructure', targetUnit: 'Azure subscription' },
  gcp: { displayName: 'Google Cloud', kind: 'infrastructure', targetUnit: 'GCP project' },
  oci: { displayName: 'Oracle Cloud Infrastructure', kind: 'infrastructure', targetUnit: 'OCI compartment' },
  digitalocean: { displayName: 'DigitalOcean', kind: 'infrastructure', targetUnit: 'DigitalOcean team' },
  vultr: { displayName: 'Vultr', kind: 'infrastructure', targetUnit: 'Vultr account' },
  coreweave: { displayName: 'CoreWeave', kind: 'infrastructure', targetUnit: 'CoreWeave organization' },
  magalu: { displayName: 'Magalu Cloud', kind: 'infrastructure', targetUnit: 'Magalu Cloud tenant' },
  vercel: { displayName: 'Vercel', kind: 'platform', targetUnit: 'Vercel team' },
  render: { displayName: 'Render', kind: 'platform', targetUnit: 'Render workspace' },
  supabase: { displayName: 'Supabase', kind: 'platform', targetUnit: 'Supabase organization' },
  mock: { displayName: 'Simulation', kind: 'simulation', targetUnit: 'simulated account' },
};

export function isCloudProvider(value: string): value is CloudProvider {
  return (CLOUD_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Where a single logical resource is physically placed. Placement is per resource, never
 * per instance, so one instance may span several providers/accounts/regions (spec §42.1).
 */
export interface ResourcePlacement {
  resourceId: string;
  provider: CloudProvider;
  /** Platform id of the registered cloud target (AWS account, Azure subscription, ...). */
  targetId: string;
  region: string;
  zone?: string;
}
