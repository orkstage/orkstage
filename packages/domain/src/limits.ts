// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Optional limits per tenant, set by platform owners and admins (ADR 0007). A missing field means
 * no limit. They replace the plans and their entitlements: any template whose resources fit can be
 * used by any tenant.
 */
export interface TenantLimits {
  /** Instances that are not destroyed. Checked when an instance is created. */
  maxInstances?: number;
  /** Container services in one instance. */
  maxServicesPerInstance?: number;
  /** vCPU of one instance: each service's CPU times its replicas (or its autoscaling ceiling). */
  maxVcpuPerInstance?: number;
  /** Memory of one instance in GiB, counted like vCPU. */
  maxMemoryGiBPerInstance?: number;
  /** Replicas of any one service (or its autoscaling ceiling). */
  maxReplicasPerService?: number;
  /** Database storage of one instance in GiB. */
  maxDatabaseGiBPerInstance?: number;
  /** Custom domains of one instance (the platform subdomain does not count). */
  maxDomainsPerInstance?: number;
  /** Backup retention of any one database, in days. */
  maxBackupRetentionDays?: number;
}

export const TENANT_LIMIT_KEYS = [
  'maxInstances',
  'maxServicesPerInstance',
  'maxVcpuPerInstance',
  'maxMemoryGiBPerInstance',
  'maxReplicasPerService',
  'maxDatabaseGiBPerInstance',
  'maxDomainsPerInstance',
  'maxBackupRetentionDays',
] as const satisfies readonly (keyof TenantLimits)[];

/** The stored JSON of a tenant's limits, keeping only known keys with non negative numbers. */
export function readTenantLimits(stored: unknown): TenantLimits {
  const source = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  const limits: TenantLimits = {};
  for (const key of TENANT_LIMIT_KEYS) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) limits[key] = value;
  }
  return limits;
}

/**
 * Platform features a tenant may use in its templates. They are feature flags (on by default; a
 * platform or tenant override turns them off), read once per compilation.
 */
export interface TenantFeatures {
  multiCloud: boolean;
  multiRegion: boolean;
  autoscaling: boolean;
  customDomains: boolean;
}

export const ALL_FEATURES: TenantFeatures = { multiCloud: true, multiRegion: true, autoscaling: true, customDomains: true };

/** The feature flags behind `TenantFeatures`. */
export const TENANT_FEATURE_FLAGS: Record<keyof TenantFeatures, string> = {
  multiCloud: 'MULTI_CLOUD',
  multiRegion: 'MULTI_REGION',
  autoscaling: 'AUTOSCALING',
  customDomains: 'CUSTOM_DOMAINS',
};

export function tenantFeatures(flags: Readonly<Record<string, boolean>>): TenantFeatures {
  const read = (key: keyof TenantFeatures) => flags[TENANT_FEATURE_FLAGS[key]] ?? true;
  return { multiCloud: read('multiCloud'), multiRegion: read('multiRegion'), autoscaling: read('autoscaling'), customDomains: read('customDomains') };
}
