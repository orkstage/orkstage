import { CLOUD_PROVIDERS, PLAN_CODES } from '@co/domain/core';
import { z } from 'zod';

/**
 * Provider-neutral template format. Templates express business intent (an API, a Postgres
 * database, private connectivity), never provider resource blocks (spec §7). Provider choice
 * happens through placement slots that each instance binds to its own cloud targets.
 */

const id = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9-]{0,39}$/, 'must start with a lowercase letter; letters, digits, dashes');

const semver = z.string().regex(/^\d+\.\d+\.\d+$/, 'must be a semantic version like 1.2.0');

const backup = z.object({
  enabled: z.boolean().default(true),
  retentionDays: z.number().int().min(0).max(35).default(7),
  recoveryPointObjectiveMinutes: z.number().int().positive().optional(),
});

const base = {
  id,
  /** Placement slot this resource belongs to. */
  placement: id.default('primary'),
  /** Preferred implementation (e.g. `ecs-fargate`). Omit to let the resolver choose. */
  implementation: z.string().optional(),
  /** Disabled resources are kept in the template (so variables can toggle them) but never provisioned. */
  enabled: z.boolean().default(true),
  dependsOn: z.array(id).default([]),
  /** Provider-specific escape hatch; marked less portable and admin-only (spec §88). */
  overrides: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
};

export const networkResource = z.object({
  ...base,
  type: z.literal('network'),
  strategy: z.enum(['isolated', 'shared']).default('isolated'),
  availabilityZones: z.number().int().min(1).max(3).default(1),
  natGateway: z.boolean().default(false),
});

export const containerServiceResource = z.object({
  ...base,
  type: z.literal('compute.container-service'),
  /** Catalog reference, e.g. `catalog://orders-api`. Resolved to an immutable digest at deploy. */
  image: z.string().min(1),
  replicas: z.number().int().min(0).max(100).default(1),
  cpu: z.number().positive().max(16).default(0.25),
  memoryMiB: z.number().int().min(128).max(122880).default(512),
  port: z.number().int().min(1).max(65535).optional(),
  public: z.boolean().default(false),
  healthCheckPath: z.string().startsWith('/').optional(),
  autoscaling: z
    .object({ minReplicas: z.number().int().min(0), maxReplicas: z.number().int().min(1), targetCpuPercent: z.number().int().min(10).max(95) })
    .optional(),
  critical: z.boolean().default(true),
});

export const registryResource = z.object({
  ...base,
  type: z.literal('container-registry'),
  scanOnPush: z.boolean().default(true),
  immutableTags: z.boolean().default(true),
});

export const postgresResource = z.object({
  ...base,
  type: z.literal('database.postgresql'),
  version: z.string().default('17'),
  size: z.enum(['micro', 'small', 'medium', 'large', 'xlarge']).default('small'),
  storageGiB: z.number().int().min(1).max(16384).default(20),
  highAvailability: z.enum(['none', 'same-zone', 'zone-redundant']).default('none'),
  publicAccess: z.boolean().default(false),
  backup: backup.default({ enabled: true, retentionDays: 7 }),
  critical: z.boolean().default(true),
});

export const redisResource = z.object({
  ...base,
  type: z.literal('cache.redis'),
  size: z.enum(['micro', 'small', 'medium', 'large']).default('micro'),
  replicas: z.number().int().min(0).max(5).default(0),
  critical: z.boolean().default(false),
});

export const queueResource = z.object({
  ...base,
  type: z.literal('queue'),
  fifo: z.boolean().default(false),
  deadLetter: z.boolean().default(true),
  critical: z.boolean().default(false),
});

export const objectStorageResource = z.object({
  ...base,
  type: z.literal('object-storage'),
  tier: z.enum(['standard', 'infrequent', 'archive']).default('standard'),
  versioning: z.boolean().default(false),
  publicAccess: z.boolean().default(false),
  retentionDays: z.number().int().min(0).optional(),
  critical: z.boolean().default(false),
});

export const ingressResource = z.object({
  ...base,
  type: z.literal('ingress'),
  /** Container services routed through this ingress. */
  routes: z.array(z.object({ service: id, pathPrefix: z.string().startsWith('/').default('/') })).min(1),
  tls: z.boolean().default(true),
});

export const dnsResource = z.object({
  ...base,
  type: z.literal('dns'),
  subdomain: z.boolean().default(true),
  customDomain: z.enum(['disabled', 'optional', 'required']).default('disabled'),
  /** The ingress this DNS name points to. */
  target: id,
});

export const templateResource = z.discriminatedUnion('type', [
  networkResource,
  containerServiceResource,
  registryResource,
  postgresResource,
  redisResource,
  queueResource,
  objectStorageResource,
  ingressResource,
  dnsResource,
]);

export const RESOURCE_TYPES = [
  'network',
  'compute.container-service',
  'container-registry',
  'database.postgresql',
  'cache.redis',
  'queue',
  'object-storage',
  'ingress',
  'dns',
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const placementSlot = z.object({
  name: id,
  description: z.string().optional(),
  /** Providers allowed for this slot. Empty means any registered provider. */
  providers: z.array(z.enum(CLOUD_PROVIDERS)).default([]),
});

export const connectivityRequirement = z.object({
  from: id,
  to: id,
  protocol: z.enum(['tcp', 'http', 'https', 'postgres', 'redis', 'amqp']),
  port: z.number().int().min(1).max(65535).optional(),
  /** private-preferred falls back to TLS over a public endpoint with allowlisting when private links are not justified. */
  mode: z.enum(['private-required', 'private-preferred', 'secure']).default('private-preferred'),
});

export const templateVariable = z.object({
  name: id,
  description: z.string().optional(),
  type: z.enum(['number', 'string', 'boolean']),
  default: z.union([z.number(), z.string(), z.boolean()]),
  min: z.number().optional(),
  max: z.number().optional(),
  allowed: z.array(z.string()).optional(),
  /** Field this variable sets, as `<resourceId>.<field>`, e.g. `api.replicas`. */
  target: z.string().regex(/^[a-z][a-zA-Z0-9-]*\.[a-zA-Z][a-zA-Z0-9]*$/),
});

export const environmentTemplate = z.object({
  apiVersion: z.literal('platform/v1'),
  kind: z.literal('EnvironmentTemplate'),
  metadata: z.object({
    name: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
    version: semver,
    displayName: z.string().min(1),
    description: z.string().default(''),
    /** Non-production templates carry an explicit warning in the UI (spec §5, Profile A). */
    nonProduction: z.boolean().default(false),
    profile: z.enum(['shared-sandbox', 'dedicated-sandbox', 'starter', 'growth', 'scale']),
  }),
  spec: z.object({
    plans: z.array(z.enum(PLAN_CODES)).min(1),
    placements: z.array(placementSlot).min(1),
    variables: z.array(templateVariable).default([]),
    resources: z.array(templateResource).min(1),
    connectivity: z.array(connectivityRequirement).default([]),
    observability: z
      .object({
        logs: z.boolean().default(true),
        metrics: z.boolean().default(true),
        traces: z.boolean().default(false),
        uptime: z.boolean().default(true),
        alerts: z.boolean().default(true),
      })
      .default({ logs: true, metrics: true, traces: false, uptime: true, alerts: true }),
  }),
});

export type EnvironmentTemplate = z.infer<typeof environmentTemplate>;
export type TemplateResource = z.infer<typeof templateResource>;
export type ContainerServiceResource = z.infer<typeof containerServiceResource>;
export type PostgresResource = z.infer<typeof postgresResource>;
export type ConnectivityRequirement = z.infer<typeof connectivityRequirement>;
export type PlacementSlot = z.infer<typeof placementSlot>;
export type TemplateVariable = z.infer<typeof templateVariable>;
