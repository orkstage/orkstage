import type { CloudProvider, FailureClass, HealthState } from '@co/domain';

/**
 * A registered cloud target: an AWS account, Azure subscription, GCP project or OCI tenancy
 * (spec §42.5). Only non-secret configuration lives here; credentials are referenced, never
 * embedded.
 */
export interface CloudTarget {
  id: string;
  provider: CloudProvider;
  name: string;
  /** Non-secret provider config, e.g. `{ accountId, roleArn }` or `{ subscriptionId }`. */
  config: Record<string, unknown>;
  /** Reference into the secret store (e.g. an external-id secret). Never the secret itself. */
  credentialRef?: string;
  allowedRegions: string[];
  defaultRegion: string;
}

export interface ProviderContext {
  target: CloudTarget;
  region: string;
  correlationId: string;
  signal?: AbortSignal;
  /** Progress sink for long operations (shown in the deployment log). Never pass secrets. */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** One implementation choice for a logical resource kind on a provider (spec §42.6). */
export interface CloudCapability {
  provider: CloudProvider;
  /** Logical resource type, e.g. `compute.container-service`. */
  serviceKind: string;
  /** Implementation id, e.g. `ecs-fargate`. */
  capability: string;
  displayName: string;
  /** Regions where available; `*` means every region the target allows. */
  regions: string[] | '*';
  /** The implementation picked when a template does not ask for one. */
  isDefault?: boolean;
  /** Feature flags this implementation supports, e.g. `ha:zone-redundant`, `autoscaling`. */
  features: string[];
  /** Features unavailable in specific regions. */
  regionalGaps?: Record<string, string[]>;
  supportsEncryption: boolean;
  supportsBackup: boolean;
  limitations?: string[];
  /** Static approximate pricing used when no pricing adapter is configured. */
  pricing?: CapabilityPricing;
}

export interface CapabilityPricing {
  currency: 'USD';
  /** Fixed monthly cost of having the resource at all. */
  baseMonthly: number;
  /** Additional monthly cost per unit; units depend on the resource kind. */
  perUnitMonthly?: Partial<Record<'vcpu' | 'memoryGiB' | 'storageGiB' | 'replica' | 'availabilityZone', number>>;
  /** Monthly cost by logical size (`micro`, `small`, ...) for sized resources like databases. */
  bySize?: Record<string, number>;
  /** Multiplier applied when high availability is enabled (e.g. 2 for a standby replica). */
  haMultiplier?: number;
  /** Where the numbers come from, shown next to estimates. */
  source: string;
}

export interface ResourceRequest {
  resourceId: string;
  serviceKind: string;
  capability: string;
  /** Deterministic physical name within provider limits. */
  name: string;
  tags: Record<string, string>;
  /** Resolved, provider-neutral desired spec for this resource. */
  spec: Record<string, unknown>;
  /** Outputs of already-provisioned dependencies, keyed by resource id. */
  dependencyOutputs: Record<string, ResourceOutputs>;
  /** Stable key for this desired state; adapters must treat repeats as no-ops. */
  idempotencyKey: string;
}

export type ResourceOutputs = Record<string, string | number | boolean>;

export interface ResourceIdentifier {
  resourceId: string;
  serviceKind: string;
  capability: string;
  name: string;
  providerResourceId?: string;
}

export interface ResourceResult {
  providerResourceId: string;
  outputs: ResourceOutputs;
  /** True when the call changed nothing because the resource already matched. */
  unchanged: boolean;
}

export interface ResourceState {
  exists: boolean;
  providerResourceId?: string;
  outputs: ResourceOutputs;
  /** Hash of the spec the provider is actually running, when observable (drift detection). */
  observedSpecHash?: string;
}

export interface ResourcePlan {
  changes: { add: number; change: number; remove: number };
  actions: { address: string; action: string }[];
  /** True when any action deletes or replaces something (data loss / downtime risk). */
  destructive: boolean;
}

export interface HealthResult {
  state: HealthState;
  message?: string;
  latencyMs?: number;
  checkedAt: string;
}

export type ValidationCheckStatus = 'ok' | 'missing' | 'error' | 'skipped';

export interface TargetValidationCheck {
  name: string;
  status: ValidationCheckStatus;
  message: string;
}

export interface TargetValidationResult {
  ok: boolean;
  checks: TargetValidationCheck[];
  validatedAt: string;
  /** Provider-confirmed identity, e.g. the AWS account id the role resolved to. */
  identity?: string;
}

export interface LogLine {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  attributes?: Record<string, string>;
}

export interface MetricPoint {
  timestamp: string;
  value: number;
}

/**
 * Every provider integration implements this contract (spec §8). The domain never imports a
 * cloud SDK; it only talks to adapters. Adapters must be idempotent: `ensureResource` creates
 * or converges a resource, and repeating it with the same idempotency key changes nothing.
 */
export interface CloudProviderAdapter {
  readonly provider: CloudProvider;
  /** True for simulation adapters. The UI labels simulated deployments explicitly. */
  readonly simulated: boolean;

  validateTarget(ctx: ProviderContext): Promise<TargetValidationResult>;
  capabilities(target: CloudTarget): CloudCapability[];

  ensureResource(ctx: ProviderContext, request: ResourceRequest): Promise<ResourceResult>;
  deleteResource(ctx: ProviderContext, resource: ResourceIdentifier): Promise<void>;
  getResource(ctx: ProviderContext, resource: ResourceIdentifier): Promise<ResourceState>;
  checkHealth(ctx: ProviderContext, resource: ResourceIdentifier): Promise<HealthResult>;
  /**
   * Asks the provider API whether the resource is really there. `false` only when the provider
   * positively reports it gone (deleted out of band); `undefined` when it cannot tell. Lets a
   * resumed or repeated apply re-create it instead of trusting recorded state.
   */
  probeExists?(ctx: ProviderContext, resource: ResourceIdentifier): Promise<boolean | undefined>;

  /**
   * Optional speculative plan for an existing resource: the provider-level changes an
   * ensureResource call would make. Lets the platform show real diffs and catch destructive
   * actions (delete/replace) before approval.
   */
  planResource?(ctx: ProviderContext, request: ResourceRequest): Promise<ResourcePlan>;

  getLogs?(ctx: ProviderContext, resource: ResourceIdentifier, limit: number): Promise<LogLine[]>;
  getMetric?(ctx: ProviderContext, resource: ResourceIdentifier, metric: string, minutes: number): Promise<MetricPoint[]>;
}

/** Error raised by adapters. The failure class drives retry and incident behaviour. */
export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly failureClass: FailureClass,
    readonly provider: CloudProvider,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
