// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Request bodies shared by the API (validation) and the web console (forms). The domain
 * packages stay free of HTTP concerns; this package is the HTTP contract. Kept dependency-free
 * so the browser bundle stays small: enum values are duplicated from @orkstage/domain on purpose and
 * checked against it in API tests.
 */

const slug = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, 'lowercase letters, digits and dashes');
const uuid = z.uuid();

/** Secret references the platform can resolve: `env://NAME`, `aws-sm://<name-or-arn>[#jsonKey]`. */
export const SECRET_REF_PATTERN = /^(env|aws-sm):\/\/\S+$/;

export const PROVIDERS = ['aws', 'azure', 'gcp', 'oci', 'digitalocean', 'vultr', 'coreweave', 'magalu', 'vercel', 'render', 'supabase', 'mock'] as const;
export const ENVIRONMENTS = ['production', 'staging', 'development', 'sandbox'] as const;
/** Environments a cloud target serves: one of the instance environments, or `any` (no guard). */
export const TARGET_ENVIRONMENTS = [...ENVIRONMENTS, 'any'] as const;
export const HEALTH_STATES = ['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN', 'MAINTENANCE'] as const;
export const STATUS_STATES = ['OPERATIONAL', 'DEGRADED', 'PARTIAL_OUTAGE', 'MAJOR_OUTAGE', 'MAINTENANCE', 'UNKNOWN'] as const;
export const INCIDENT_STATUSES = ['INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED'] as const;

export const devLoginSchema = z.object({ email: z.email() });

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
  tenantId: uuid.optional(),
  instanceId: uuid.optional(),
  status: z.string().optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

const count = z.number().int().min(0).max(1_000_000);
const amount = z.number().min(0).max(1_000_000);

/**
 * Optional limits of one tenant (ADR 0007, `TenantLimits` in @orkstage/domain). A missing field is
 * no limit. Only platform owners and admins set them; an update replaces all of them.
 */
export const tenantLimitsSchema = z
  .object({
    maxInstances: count.optional(),
    maxServicesPerInstance: count.optional(),
    maxVcpuPerInstance: amount.optional(),
    maxMemoryGiBPerInstance: amount.optional(),
    maxReplicasPerService: count.optional(),
    maxDatabaseGiBPerInstance: amount.optional(),
    maxDomainsPerInstance: count.optional(),
    maxBackupRetentionDays: count.optional(),
  })
  .strict();
export type TenantLimitsInput = z.infer<typeof tenantLimitsSchema>;

export const createTenantSchema = z.object({
  name: z.string().min(2).max(80),
  slug,
  limits: tenantLimitsSchema.default({}),
  allowedEmailDomains: z.array(z.string()).default([]),
});

export const updateTenantSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  limits: tenantLimitsSchema.optional(),
});

export const createCloudTargetSchema = z.object({
  provider: z.enum(PROVIDERS),
  name: z.string().min(2).max(80),
  /** Instances of another environment cannot deploy here (policy `target-environment`); `any` allows all. */
  environment: z.enum(TARGET_ENVIRONMENTS).default('any'),
  /** Non-secret configuration only. The API rejects keys that look like secrets. */
  config: z.record(z.string(), z.unknown()),
  credentialRef: z.string().max(300).regex(SECRET_REF_PATTERN, 'Use a secret reference (env://NAME or aws-sm://name-or-arn), never the secret value.').optional(),
  allowedRegions: z.array(z.string().min(2)).min(1),
  defaultRegion: z.string().min(2),
  tenantId: uuid.optional(),
  maxConcurrentDeployments: z.number().int().min(1).max(20).default(3),
});

/**
 * Editing a target (A4). Provider, tenant and environment never change; neither do the config
 * fields a provider marks `fixed` (the account, the state location). `config` is merged into the
 * stored one, and a `null` value removes that key. Any change clears the last validation.
 */
export const updateCloudTargetSchema = z
  .object({
    name: z.string().min(2).max(80).optional(),
    config: z.record(z.string(), z.unknown().nullable()).optional(),
    credentialRef: z.string().max(300).regex(SECRET_REF_PATTERN, 'Use a secret reference (env://NAME or aws-sm://name-or-arn), never the secret value.').optional(),
    allowedRegions: z.array(z.string().min(2)).min(1).optional(),
    defaultRegion: z.string().min(2).optional(),
    maxConcurrentDeployments: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export const validateTargetSchema = z.object({ region: z.string().optional() });

export const bindingSchema = z.object({ targetId: uuid, region: z.string().min(2) });

/** One provider of a profile: the provider comes from the target; no region means its default. */
export const profileTargetSchema = z.object({ targetId: uuid, region: z.string().min(2).optional() });

/**
 * A named setup for an environment (ADR 0007): the target, and optionally the region, per
 * provider. Without `tenantId` the profile is shared with every tenant (platform staff only).
 */
export const createProfileSchema = z.object({
  tenantId: uuid.optional(),
  name: z.string().min(2).max(80),
  environment: z.enum(TARGET_ENVIRONMENTS),
  isDefault: z.boolean().default(false),
  targets: z.array(profileTargetSchema).min(1).max(20),
});
export const updateProfileSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  environment: z.enum(TARGET_ENVIRONMENTS).optional(),
  targets: z.array(profileTargetSchema).min(1).max(20).optional(),
});
/** One default profile per tenant scope and environment: setting one clears the previous. */
export const setDefaultProfileSchema = z.object({ isDefault: z.boolean() });

export const createInstanceSchema = z.object({
  tenantId: uuid,
  name: z.string().min(2).max(80),
  slug,
  environment: z.enum(ENVIRONMENTS).default('production'),
  templateVersionId: uuid,
  variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /**
   * Slots left out are bound from this profile, or from the default profile of the instance's
   * environment (ADR 0007), when it has a target for a provider the slot accepts.
   */
  bindings: z.record(z.string(), bindingSchema).default({}),
  profileId: uuid.optional(),
});

export const updateInstanceSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  bindings: z.record(z.string(), bindingSchema).optional(),
  protectedFromDestroy: z.boolean().optional(),
});

export const upgradeInstanceSchema = z.object({ templateVersionId: uuid });

export const destroyInstanceSchema = z.object({
  /** Must equal the instance slug: an explicit confirmation for a destructive action. */
  confirm: z.string(),
});

export const createTemplateSchema = z.object({ source: z.string().min(1).max(200_000) });
export const validateTemplateSchema = z.object({
  source: z.string().min(1).max(200_000).optional(),
  /** Also check this tenant's limits and features (ADR 0007). */
  tenantId: uuid.optional(),
});
export const cloneTemplateSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  displayName: z.string().min(2).max(80),
});

export const createIncidentSchema = z.object({
  tenantId: uuid,
  instanceId: uuid.optional(),
  title: z.string().min(3).max(200),
  impact: z.enum(STATUS_STATES).default('DEGRADED'),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  message: z.string().min(1).max(5000),
  componentIds: z.array(uuid).default([]),
});

export const incidentUpdateSchema = z.object({
  status: z.enum(INCIDENT_STATUSES),
  message: z.string().min(1).max(5000),
  impact: z.enum(STATUS_STATES).optional(),
});

/** Parameters for a trigger run; only the names the template marks overridable are accepted. */
export const runTriggerSchema = z.object({
  params: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()])).default({}),
});

/** Turns a feature flag on or off, platform wide or (with tenantId) for one tenant. */
export const setFeatureFlagSchema = z.object({
  enabled: z.boolean(),
  tenantId: uuid.optional(),
});

/** Simulation controls, accepted only for resources on mock targets. */
export const simulateSchema = z.object({
  resourceId: z.string().min(1),
  health: z.enum(HEALTH_STATES).nullable().optional(),
  drift: z.boolean().optional(),
  /** Pin a metric to a value (null: back to the simulated series), to exercise metric alerts. */
  metric: z.object({ name: z.enum(['cpu', 'memory', 'requests', 'errors_5xx', 'latency_ms', 'connections']), value: z.number().nullable() }).optional(),
});

/** The platform's metric names, the same on every provider (open item 7). */
export const PLATFORM_METRICS = ['cpu', 'memory', 'requests', 'errors_5xx', 'latency_ms', 'connections'] as const;
export const ALERT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

/** Health rule: consecutive failed health checks of a resource. */
export const healthConditionSchema = z.object({
  signal: z.literal('health'),
  critical: z.boolean().optional(),
  consecutiveFailures: z.number().int().min(1).max(20),
});

/** Metric rule: a statistic of a metric over a window, compared with a threshold. */
export const metricConditionSchema = z.object({
  signal: z.literal('metric'),
  metric: z.enum(PLATFORM_METRICS),
  /** Only these resource types (e.g. `compute.container-service`); all with the metric when absent. */
  resourceTypes: z.array(z.string().min(1)).max(20).optional(),
  operator: z.enum(['>', '>=', '<', '<=']),
  threshold: z.number(),
  windowMinutes: z.number().int().min(1).max(60),
  statistic: z.enum(['avg', 'max', 'min']).default('avg'),
});

export const alertConditionSchema = z.discriminatedUnion('signal', [healthConditionSchema, metricConditionSchema]);

export const createAlertRuleSchema = z.object({
  /** Absent: a platform rule for every tenant (platform staff only). */
  tenantId: uuid.optional(),
  name: z.string().min(2).max(120),
  condition: alertConditionSchema,
  severity: z.enum(ALERT_SEVERITIES).default('medium'),
  actions: z.array(z.enum(['create_incident', 'notify_owners'])).min(1).default(['create_incident', 'notify_owners']),
  /** After an incident of this rule resolves, no new one for the same resource for this long. */
  cooldownSeconds: z.number().int().min(0).max(86_400).default(900),
  /** Resolve the incident when the condition clears; off means a person resolves it. */
  autoResolve: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
/** Unknown keys are refused: a threshold belongs in `condition`, not beside it. */
export const updateAlertRuleSchema = createAlertRuleSchema.omit({ tenantId: true }).partial().strict();

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type CreateCloudTargetInput = z.infer<typeof createCloudTargetSchema>;
export type CreateInstanceInput = z.infer<typeof createInstanceSchema>;
export type UpdateInstanceInput = z.infer<typeof updateInstanceSchema>;
export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;
export type IncidentUpdateInput = z.infer<typeof incidentUpdateSchema>;
