export const PLAN_CODES = ['FREE', 'SANDBOX', 'STARTER', 'GROWTH', 'SCALE'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export const INCIDENT_LEVELS = ['NONE', 'BASIC', 'STANDARD', 'ADVANCED'] as const;
export type IncidentLevel = (typeof INCIDENT_LEVELS)[number];

/**
 * What a plan entitles a tenant to (spec §6). Entitlements constrain templates; they never
 * dictate a concrete implementation.
 */
export interface Entitlements {
  maxInstances: number;
  maxServices: number;
  maxCpu: number;
  maxMemoryMiB: number;
  maxStorageGiB: number;
  maxDatabaseGiB: number;
  maxReplicas: number;
  maxDomains: number;
  logsRetentionDays: number;
  metricsRetentionDays: number;
  backupRetentionDays: number;
  customDomains: boolean;
  customTemplates: boolean;
  customCloudAccounts: boolean;
  multiRegion: boolean;
  multiCloud: boolean;
  autoscaling: boolean;
  advancedAlerts: boolean;
  incidentLevel: IncidentLevel;
  supportLevel: 'COMMUNITY' | 'STANDARD' | 'PRIORITY' | 'DEDICATED';
  featureFlags: string[];
}

/** Built-in plan defaults. The database copy is authoritative; these seed it. */
export const DEFAULT_ENTITLEMENTS: Record<PlanCode, Entitlements> = {
  FREE: {
    maxInstances: 1,
    maxServices: 2,
    maxCpu: 0.5,
    maxMemoryMiB: 1024,
    maxStorageGiB: 5,
    maxDatabaseGiB: 1,
    maxReplicas: 1,
    maxDomains: 0,
    logsRetentionDays: 1,
    metricsRetentionDays: 1,
    backupRetentionDays: 0,
    customDomains: false,
    customTemplates: false,
    customCloudAccounts: false,
    multiRegion: false,
    multiCloud: false,
    autoscaling: false,
    advancedAlerts: false,
    incidentLevel: 'NONE',
    supportLevel: 'COMMUNITY',
    featureFlags: [],
  },
  SANDBOX: {
    maxInstances: 2,
    maxServices: 4,
    maxCpu: 1,
    maxMemoryMiB: 2048,
    maxStorageGiB: 20,
    maxDatabaseGiB: 10,
    maxReplicas: 1,
    maxDomains: 1,
    logsRetentionDays: 3,
    metricsRetentionDays: 7,
    backupRetentionDays: 1,
    customDomains: false,
    customTemplates: false,
    customCloudAccounts: false,
    multiRegion: false,
    multiCloud: false,
    autoscaling: false,
    advancedAlerts: false,
    incidentLevel: 'BASIC',
    supportLevel: 'COMMUNITY',
    featureFlags: [],
  },
  STARTER: {
    maxInstances: 3,
    maxServices: 8,
    maxCpu: 4,
    maxMemoryMiB: 8192,
    maxStorageGiB: 100,
    maxDatabaseGiB: 50,
    maxReplicas: 2,
    maxDomains: 3,
    logsRetentionDays: 14,
    metricsRetentionDays: 30,
    backupRetentionDays: 7,
    customDomains: true,
    customTemplates: false,
    customCloudAccounts: false,
    multiRegion: false,
    multiCloud: false,
    autoscaling: false,
    advancedAlerts: false,
    incidentLevel: 'STANDARD',
    supportLevel: 'STANDARD',
    featureFlags: [],
  },
  GROWTH: {
    maxInstances: 10,
    maxServices: 20,
    maxCpu: 16,
    maxMemoryMiB: 32768,
    maxStorageGiB: 500,
    maxDatabaseGiB: 250,
    maxReplicas: 6,
    maxDomains: 10,
    logsRetentionDays: 30,
    metricsRetentionDays: 90,
    backupRetentionDays: 14,
    customDomains: true,
    customTemplates: true,
    customCloudAccounts: true,
    multiRegion: false,
    multiCloud: true,
    autoscaling: true,
    advancedAlerts: true,
    incidentLevel: 'STANDARD',
    supportLevel: 'PRIORITY',
    featureFlags: ['CUSTOM_TEMPLATES'],
  },
  SCALE: {
    maxInstances: 100,
    maxServices: 100,
    maxCpu: 256,
    maxMemoryMiB: 524288,
    maxStorageGiB: 10000,
    maxDatabaseGiB: 4000,
    maxReplicas: 50,
    maxDomains: 100,
    logsRetentionDays: 90,
    metricsRetentionDays: 395,
    backupRetentionDays: 35,
    customDomains: true,
    customTemplates: true,
    customCloudAccounts: true,
    multiRegion: true,
    multiCloud: true,
    autoscaling: true,
    advancedAlerts: true,
    incidentLevel: 'ADVANCED',
    supportLevel: 'DEDICATED',
    featureFlags: ['CUSTOM_TEMPLATES', 'ADVANCED_SCALING', 'DRIFT_DETECTION'],
  },
};

/** A plan's entitlements: the defaults for its code with the values stored on the plan on top. */
export function entitlementsFor(code: string, stored: unknown): Entitlements {
  const base = DEFAULT_ENTITLEMENTS[code as PlanCode] ?? DEFAULT_ENTITLEMENTS.FREE;
  return { ...base, ...((stored ?? {}) as Partial<Entitlements>) };
}
