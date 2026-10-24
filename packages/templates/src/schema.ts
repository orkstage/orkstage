// SPDX-License-Identifier: AGPL-3.0-only
import { CLOUD_PROVIDERS } from '@orkstage/domain/core';
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
  /**
   * Create an access key limited to this bucket, kept in the provider's secret store, for
   * consumers on other providers (a Vercel or Render app). Services on the same provider use
   * their own identity instead.
   */
  accessKeys: z.boolean().default(false),
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

/**
 * A website, landing page or web app built from a Git repository and served by a frontend
 * platform (Vercel, Render static sites). Dependencies listed in `dependsOn` reach it as
 * environment variables: connection settings in plain text, credentials as encrypted values.
 */
export const webFrontendResource = z.object({
  ...base,
  type: z.literal('web.frontend'),
  source: z.object({
    /** Repository as `owner/name` on the platform's connected Git provider. */
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'use owner/name'),
    branch: z.string().min(1).default('main'),
    /** Folder of the app inside a monorepo. */
    rootDirectory: z.string().optional(),
    gitProvider: z.enum(['github', 'gitlab', 'bitbucket']).default('github'),
  }),
  /** Framework preset, e.g. `nextjs`, `vite`, `astro`; omit to let the platform detect it. */
  framework: z.string().max(40).optional(),
  buildCommand: z.string().max(500).optional(),
  installCommand: z.string().max(500).optional(),
  outputDirectory: z.string().max(200).optional(),
  nodeVersion: z.string().regex(/^\d+(\.x)?$/).optional(),
  /** Plain settings. Credentials never go here: they come from dependencies or secret references. */
  environment: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4000)).default({}),
  domains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(20).default([]),
  /** Build a preview for each pull request when the platform supports it. */
  previewDeployments: z.boolean().default(true),
  healthCheckPath: z.string().startsWith('/').default('/'),
  critical: z.boolean().default(true),
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
  webFrontendResource,
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
  'web.frontend',
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

/**
 * A named operation on one resource (redeploy a frontend, restart a service, purge a cache),
 * with default parameters. Operators run it from the console, CLI or API; `schedule` runs it on a
 * cron; `webhook` lets an API key holder (a CI pipeline, a CMS) start it with its own parameters,
 * limited to the names in `overridable`.
 */
export const templateTrigger = z.object({
  name: id,
  description: z.string().max(300).optional(),
  resource: id,
  /**
   * A catalog action (`service.restart`, ADR 0009) or one the resource's provider offers by its own
   * name (`redeploy`). Checked when the trigger runs.
   */
  action: z.string().regex(/^[a-z][a-z0-9-]{1,40}(\.[a-z][a-zA-Z0-9-]{1,40})?$/),
  /** Raises the role needed to run it above the action's own minimum (never lowers it). */
  role: z.enum(['CustomerDeveloper', 'CustomerAdmin', 'CustomerOwner']).optional(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  overridable: z.array(z.string()).default([]),
  on: z
    .object({
      manual: z.boolean().default(true),
      /** Five field cron expression in UTC, e.g. `0 3 * * *`. */
      schedule: z.string().regex(/^(\S+\s+){4}\S+$/, 'five field cron expression').optional(),
      webhook: z.boolean().default(false),
    })
    .default({ manual: true, webhook: false }),
});

/**
 * How deployments of this template reach traffic and how long they are watched (ADR 0009). A
 * strategy other than `rolling` needs a provider that supports it for every container service.
 */
export const templateRelease = z.object({
  strategy: z.enum(['rolling', 'canary', 'blueGreen']).default('rolling'),
  /** Share of traffic a canary gets during the bake period. */
  trafficPercent: z.number().int().min(1).max(50).default(10),
  /** Minutes after a deployment during which an incident or an unhealthy service rolls it back; 0 turns watching off. */
  bakeMinutes: z.number().int().min(0).max(240).default(0),
  autoRollback: z.boolean().default(true),
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
    /** Free form labels for search and the marketplace (ADR 0007), for example `starter` or `postgres`. */
    tags: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9 ]{0,31}$/, 'Tags are lowercase letters, digits and spaces, up to 32 characters.'))
      .max(20)
      .default([]),
    /** Deprecated (ADR 0007): accepted and ignored with a warning for one release, then rejected. Use tags. */
    profile: z.string().optional(),
  }),
  spec: z.object({
    /** Deprecated (ADR 0007): accepted and ignored with a warning for one release, then rejected. */
    plans: z.array(z.string()).optional(),
    placements: z.array(placementSlot).min(1),
    variables: z.array(templateVariable).default([]),
    resources: z.array(templateResource).min(1),
    connectivity: z.array(connectivityRequirement).default([]),
    triggers: z.array(templateTrigger).default([]),
    release: templateRelease.optional(),
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
export type TemplateTrigger = z.infer<typeof templateTrigger>;
export type TemplateRelease = z.infer<typeof templateRelease>;
export type WebFrontendResource = z.infer<typeof webFrontendResource>;
