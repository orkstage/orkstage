// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudTarget } from '@orkstage/cloud-core';
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
  instance: { id: string; slug: string; environment: EnvironmentKind };
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
}

/** Platform-wide policy knobs (spec §33). Policies are evaluated before any cloud mutation. */
export interface PolicyConfig {
  /** Regions allowed platform-wide, in addition to each target's own allow-list. */
  allowedRegions?: string[];
  maxMonthlyCostUsd?: number;
  maxReplicas?: number;
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
  source: string;
}

export interface CostEstimate {
  currency: 'USD';
  period: 'monthly';
  total: number;
  /** `approximate` when every line priced; `partial` when some lines lack pricing. */
  confidence: 'approximate' | 'partial' | 'unavailable';
  lines: CostLine[];
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
