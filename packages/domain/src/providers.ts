// SPDX-License-Identifier: AGPL-3.0-only
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
  /** A representative region, used for previews and estimates without a real target. */
  previewRegion: string;
}

export const PROVIDER_INFO: Record<CloudProvider, ProviderInfo> = {
  aws: { displayName: 'Amazon Web Services', kind: 'infrastructure', targetUnit: 'AWS account', previewRegion: 'us-east-1' },
  azure: { displayName: 'Microsoft Azure', kind: 'infrastructure', targetUnit: 'Azure subscription', previewRegion: 'eastus' },
  gcp: { displayName: 'Google Cloud', kind: 'infrastructure', targetUnit: 'GCP project', previewRegion: 'us-central1' },
  oci: { displayName: 'Oracle Cloud Infrastructure', kind: 'infrastructure', targetUnit: 'OCI compartment', previewRegion: 'us-ashburn-1' },
  digitalocean: { displayName: 'DigitalOcean', kind: 'infrastructure', targetUnit: 'DigitalOcean team', previewRegion: 'nyc3' },
  vultr: { displayName: 'Vultr', kind: 'infrastructure', targetUnit: 'Vultr account', previewRegion: 'ewr' },
  coreweave: { displayName: 'CoreWeave', kind: 'infrastructure', targetUnit: 'CoreWeave organization', previewRegion: 'US-EAST-04A' },
  magalu: { displayName: 'Magalu Cloud', kind: 'infrastructure', targetUnit: 'Magalu Cloud tenant', previewRegion: 'br-se1' },
  vercel: { displayName: 'Vercel', kind: 'platform', targetUnit: 'Vercel team', previewRegion: 'iad1' },
  render: { displayName: 'Render', kind: 'platform', targetUnit: 'Render workspace', previewRegion: 'oregon' },
  supabase: { displayName: 'Supabase', kind: 'platform', targetUnit: 'Supabase organization', previewRegion: 'us-east-1' },
  mock: { displayName: 'Simulation', kind: 'simulation', targetUnit: 'simulated account', previewRegion: 'us-east-1' },
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
