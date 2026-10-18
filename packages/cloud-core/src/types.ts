// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudProvider, FailureClass, HealthState } from '@orkstage/domain';

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
  /** The instance environment this target serves (`production`, `staging`, ...), or `any`. */
  environment?: string;
}

export interface ProviderContext {
  target: CloudTarget;
  region: string;
  correlationId: string;
  signal?: AbortSignal;
  /** Progress sink for long operations (shown in the deployment log). Never pass secrets. */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /**
   * Reads the credentials a dependency published through its `secret_ref` output, by resource id,
   * from whichever provider owns it (e.g. a Vercel project reading a Supabase database password).
   * Values are for the call only: never log, return or persist them.
   */
  dependencySecret?: (resourceId: string) => Promise<Record<string, string>>;
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
  /**
   * The deployment this request belongs to. Its plan phase saves each provider plan under this id
   * and its apply phase applies exactly that plan (open item 5). Absent for previews.
   */
  planId?: string;
}

export type ResourceOutputs = Record<string, string | number | boolean>;

export interface ResourceIdentifier {
  resourceId: string;
  serviceKind: string;
  capability: string;
  name: string;
  providerResourceId?: string;
  /** Outputs recorded at the last successful apply, when the caller has them (saves a state read). */
  outputs?: ResourceOutputs;
}

/** An operation run on an existing resource: what a template trigger or an operator asks for. */
export interface ResourceActionRequest {
  /** One of the adapter's `actions(capability)` names, e.g. `redeploy`. */
  action: string;
  params: Record<string, string | number | boolean>;
}

export interface ResourceActionResult {
  /** Provider id of what was started (a deployment, a backup), when there is one. */
  reference?: string;
  status: 'started' | 'completed';
  message: string;
  url?: string;
}

export interface ResourceActionDescriptor {
  name: string;
  description: string;
  /** Parameters the action accepts; anything else is rejected before the provider is called. */
  params: { name: string; type: 'string' | 'number' | 'boolean'; required?: boolean; description?: string }[];
}

/** One rollout as the provider records it (Vercel deployment, Render deploy, Cloud Run revision). */
export interface ProviderDeployment {
  id: string;
  status: 'queued' | 'building' | 'deploying' | 'live' | 'failed' | 'cancelled' | 'superseded';
  createdAt: string;
  finishedAt?: string;
  url?: string;
  /** Source revision, e.g. a commit SHA or an image digest. */
  revision?: string;
  message?: string;
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

/** One resource changed outside the platform: which attributes (names only, never values). */
export interface DriftChange {
  address: string;
  action: string;
  attributes: string[];
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

/** `warn` reports a limitation that does not block deploying (e.g. a service the target is not scoped for). */
export type ValidationCheckStatus = 'ok' | 'missing' | 'error' | 'skipped' | 'warn';

export interface ValidateTargetOptions {
  /** Service kinds about to be deployed: permission gaps for these fail validation. */
  serviceKinds?: string[];
}

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

/** A DNS record someone must create, e.g. for certificate validation. */
export interface DnsRecord {
  name: string;
  type: 'CNAME' | 'TXT' | 'A';
  value: string;
}

/** Backups of a database as the provider reports them (open item 18). */
export interface BackupInfo {
  enabled: boolean;
  retentionDays?: number;
  /** ISO times. */
  lastBackupAt?: string;
  nextBackupAt?: string;
  /** Point in time restore window, when the provider offers one. */
  earliestRestorableAt?: string;
  latestRestorableAt?: string;
  /** The most recent failed backup, when the provider reports one. */
  lastFailure?: { at: string; message: string };
}

/** TLS certificate state for one hostname served by a resource (open item 9). */
export interface CertificateInfo {
  hostname: string;
  status: 'PENDING_VALIDATION' | 'ISSUED' | 'EXPIRED' | 'FAILED';
  /** ISO time the certificate stops being valid. */
  notAfter?: string;
  /** Records the certificate authority still needs, when the hostname is outside the platform zone. */
  records?: DnsRecord[];
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

  validateTarget(ctx: ProviderContext, opts?: ValidateTargetOptions): Promise<TargetValidationResult>;
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

  /**
   * Changes made to the real resource outside the platform since it was applied (refresh-only).
   * Empty when in sync. Adapters whose getResource reports observedSpecHash need not implement it.
   */
  detectDrift?(ctx: ProviderContext, request: ResourceRequest): Promise<DriftChange[]>;

  getLogs?(ctx: ProviderContext, resource: ResourceIdentifier, limit: number): Promise<LogLine[]>;
  getMetric?(ctx: ProviderContext, resource: ResourceIdentifier, metric: string, minutes: number): Promise<MetricPoint[]>;

  /** Backups of a database resource; null for kinds without backups (open item 18). */
  getBackups?(ctx: ProviderContext, resource: ResourceIdentifier): Promise<BackupInfo | null>;

  /** Certificates of the hostnames a `dns` or `web.frontend` resource serves (open item 9). */
  getCertificates?(ctx: ProviderContext, resource: ResourceIdentifier): Promise<CertificateInfo[]>;

  /**
   * Simulation adapters answer DNS lookups from their own records, so domain verification can be
   * exercised without a real zone. Real adapters leave this out and the platform asks public DNS.
   */
  lookupDns?(ctx: ProviderContext, name: string, type: 'TXT' | 'CNAME'): Promise<string[]>;

  /**
   * Reads a `secret_ref` this adapter published (e.g. a generated database password), so a
   * resource on another provider can be wired to it. Returns named fields such as `password`
   * or `url`. Callers must keep the values out of logs, outputs and the database.
   */
  readSecret?(ctx: ProviderContext, ref: string): Promise<Record<string, string>>;

  /** Operations available on a capability (redeploy, restart, purge cache, ...): what triggers may run. */
  actions?(capability: string): ResourceActionDescriptor[];
  runAction?(ctx: ProviderContext, resource: ResourceIdentifier, request: ResourceActionRequest): Promise<ResourceActionResult>;

  /** Recent rollouts, newest first, for platforms that keep a deployment history. */
  listDeployments?(ctx: ProviderContext, resource: ResourceIdentifier, limit: number): Promise<ProviderDeployment[]>;
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
