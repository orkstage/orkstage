// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudTarget } from '@orkstage/cloud-core';
import type { CloudProvider, Entitlements, PlanCode } from '@orkstage/domain';
import type { ConnectivityRequirement, EnvironmentTemplate, ValidationIssue } from '@orkstage/templates';

export type EnvironmentKind = 'production' | 'staging' | 'development' | 'sandbox';

/** One placement slot bound to a concrete cloud target and region. */
export interface SlotBinding {
  target: CloudTarget;
  region: string;
}

export interface CompileInput {
  template: EnvironmentTemplate;
  plan: { code: PlanCode; entitlements: Entitlements };
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

export interface ResolvedConnectivity extends ConnectivityRequirement {
  strategy: ConnectivityStrategy;
  crossCloud: boolean;
  notes: string[];
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
  plan: PlanCode;
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
