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

export const PROVIDERS = ['aws', 'azure', 'gcp', 'oci', 'mock'] as const;
export const PLAN_CODES = ['FREE', 'SANDBOX', 'STARTER', 'GROWTH', 'SCALE'] as const;
export const ENVIRONMENTS = ['production', 'staging', 'development', 'sandbox'] as const;
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

export const createTenantSchema = z.object({
  name: z.string().min(2).max(80),
  slug,
  planCode: z.enum(PLAN_CODES),
  allowedEmailDomains: z.array(z.string()).default([]),
});

export const updateTenantSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  planCode: z.enum(PLAN_CODES).optional(),
});

export const createCloudTargetSchema = z.object({
  provider: z.enum(PROVIDERS),
  name: z.string().min(2).max(80),
  environment: z.string().default('production'),
  /** Non-secret configuration only. The API rejects keys that look like secrets. */
  config: z.record(z.string(), z.unknown()),
  credentialRef: z.string().max(300).regex(SECRET_REF_PATTERN, 'Use a secret reference (env://NAME or aws-sm://name-or-arn), never the secret value.').optional(),
  allowedRegions: z.array(z.string().min(2)).min(1),
  defaultRegion: z.string().min(2),
  tenantId: uuid.optional(),
  maxConcurrentDeployments: z.number().int().min(1).max(20).default(3),
});

export const validateTargetSchema = z.object({ region: z.string().optional() });

export const bindingSchema = z.object({ targetId: uuid, region: z.string().min(2) });

export const createInstanceSchema = z.object({
  tenantId: uuid,
  name: z.string().min(2).max(80),
  slug,
  environment: z.enum(ENVIRONMENTS).default('production'),
  templateVersionId: uuid,
  variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  bindings: z.record(z.string(), bindingSchema),
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
  planCode: z.enum(PLAN_CODES).optional(),
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

/** Simulation controls, accepted only for resources on mock targets. */
export const simulateSchema = z.object({
  resourceId: z.string().min(1),
  health: z.enum(HEALTH_STATES).nullable().optional(),
  drift: z.boolean().optional(),
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type CreateCloudTargetInput = z.infer<typeof createCloudTargetSchema>;
export type CreateInstanceInput = z.infer<typeof createInstanceSchema>;
export type UpdateInstanceInput = z.infer<typeof updateInstanceSchema>;
export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;
export type IncidentUpdateInput = z.infer<typeof incidentUpdateSchema>;
