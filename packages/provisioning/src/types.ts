// SPDX-License-Identifier: AGPL-3.0-only
import type { CapabilityPricing, CloudCapability, CloudTarget } from '@orkstage/cloud-core';
import type { CloudProvider, TenantFeatures, TenantLimits } from '@orkstage/domain';
import type { ConnectivityRequirement, EnvironmentTemplate, ValidationIssue } from '@orkstage/templates';

export type EnvironmentKind = 'production' | 'staging' | 'development' | 'sandbox';

/** One placement slot bound to a concrete cloud target and region. */
export interface SlotBinding {
  target: CloudTarget;
  region: string;
}

export interface CompileInput {
  template: EnvironmentTemplate;
  /** The tenant's limits and allowed features (ADR 0007); preview and template checks pass none and all. */
  limits: TenantLimits;
  features: TenantFeatures;
  organizationId: string;
  tenant: { id: string; slug: string };
  instance: { id: string; slug: string; environment: EnvironmentKind; labels?: Record<string, string> };
  /** Slot name → binding. Every slot used by an enabled resource must be bound. */
  bindings: Record<string, SlotBinding>;
  /** Container images by catalog ref (`catalog://name`), resolved to immutable digests. */
  images?: Record<string, { uri: string; digest: string }>;
  policy?: PolicyConfig;
  /**
   * Provider feature flags for this tenant. A slot bound to a disabled provider is a blocking
   * issue; omitted means every registered provider is allowed.
   */
  providerEnabled?: (provider: CloudProvider) => boolean;
  /** Verified custom hostnames by logical resource id (`dns` or `web.frontend`), open item 9. */
  customDomains?: Record<string, string[]>;
  /**
   * Live prices (ADR 0010), for example from the AWS Pricing API, looked up before compiling. When
   * it answers nothing, the capability's bundled table for the region applies.
   */
  livePricing?: (capability: CloudCapability, region: string) => LivePricing | undefined;
  /** Resources whose custom domain certificate was seen issued, so the listener can use it. */
  customCertificatesIssued?: string[];
}

/** Platform-wide policy knobs (spec §33). Policies are evaluated before any cloud mutation. */
export interface PolicyConfig {
  /** Regions allowed platform-wide, in addition to each target's own allow-list. */
  allowedRegions?: string[];
  maxMonthlyCostUsd?: number;
  maxReplicas?: number;
  /** Container sizes services may use (vCPU and MiB); any size when absent (open item 12). */
  machineSizes?: { cpu: number; memoryMiB: number }[];
  /** Image prefixes services may run, e.g. `123456789012.dkr.ecr.us-east-1.amazonaws.com/`. */
  approvedRegistries?: string[];
  /** Instance labels every instance must carry, e.g. `cost-center`; they become cloud tags. */
  requiredLabels?: string[];
  /** Lowest TLS version load balancers accept. */
  minTlsVersion?: '1.2' | '1.3';
  /** Days service logs are kept, at least. */
  minLogRetentionDays?: number;
  /** Built-in policies turned off. Platform scope only: a tenant cannot turn a policy off. */
  disabled?: string[];
}

export interface ResolvedResource {
  id: string;
  type: string;
  slot: string;
  provider: CloudProvider;
  /** For simulated targets, the provider being imitated. */
  simulatedProvider?: string;
  targetId: string;
  targetName: string;
  region: string;
  capability: string;
  capabilityName: string;
  name: string;
  tags: Record<string, string>;
  /** Provider-neutral desired spec passed to the adapter. */
  spec: Record<string, unknown>;
  dependsOn: string[];
  critical: boolean;
  /** Hash of everything that defines this resource's desired state. */
  specHash: string;
}

export type ConnectivityStrategy =
  | 'private-network'
  | 'private-peering'
  | 'public-tls-allowlist'
  | 'public-tls'
  | 'unsatisfiable';

/**
 * What OrkStage does for a link besides classifying it (open item 4): how the consumer gets the
 * credentials the target publishes, and whether the target's firewall allows only the consumer.
 */
export interface LinkWiring {
  /**
   * `native`: same provider, the consumer reads the provider's secret store directly.
   * `copied`: the values are copied into the consumer provider's secret store at deploy time.
   * `reference`: the consumer only gets the reference (`<ID>_CREDENTIALS_REF`), its provider has no
   * secret wiring. `none`: the target publishes no credentials.
   */
  credentials: 'native' | 'copied' | 'reference' | 'none';
  /** The consumer network whose egress addresses the target's firewall allows. */
  allowlistNetwork?: string;
  /** Why an allowlist was wanted and could not be made, when that is the case. */
  allowlistGap?: string;
}

export interface ResolvedConnectivity extends ConnectivityRequirement {
  strategy: ConnectivityStrategy;
  crossCloud: boolean;
  notes: string[];
  wiring: LinkWiring;
}

export interface PolicyResult {
  policy: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  resourceId?: string;
}

export interface CostLine {
  resourceId: string;
  category: 'compute' | 'database' | 'cache' | 'storage' | 'network' | 'messaging' | 'other';
  provider: string;
  monthly: number | null;
  /** Where the price comes from, with the region it applies to. */
  source: string;
  /** Date of the price data, when known (ADR 0010). */
  asOf?: string | null;
}

export interface CostEstimate {
  currency: 'USD';
  period: 'monthly';
  total: number;
  /** `approximate` when every line priced; `partial` when some lines lack pricing. */
  confidence: 'approximate' | 'partial' | 'unavailable';
  lines: CostLine[];
  /** Every price source the lines used, with its date (ADR 0010). */
  sources?: { source: string; asOf: string | null }[];
}

export interface ResolvedInfrastructure {
  template: { name: string; version: string };
  environment: EnvironmentKind;
  resources: ResolvedResource[];
  /** Execution levels; resources within a level can run in parallel. */
  levels: string[][];
  connectivity: ResolvedConnectivity[];
  targets: Record<string, CloudTarget>;
  policyResults: PolicyResult[];
  issues: ValidationIssue[];
  cost: CostEstimate;
  desiredStateHash: string;
  valid: boolean;
}

/** Prices read from a provider's pricing API for one capability and region. */
export interface LivePricing {
  pricing: CapabilityPricing;
  source: string;
  asOf: string;
}
