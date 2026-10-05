/**
 * Cloud providers known to the platform. `mock` is a deterministic simulation provider
 * used for local development and tests; it never touches a real cloud.
 */
export const CLOUD_PROVIDERS = ['aws', 'azure', 'gcp', 'oci', 'mock'] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

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
