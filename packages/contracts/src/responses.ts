// SPDX-License-Identifier: AGPL-3.0-only
/** Response shapes returned by the API (dates are ISO strings). */

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    correlationId: string;
    details: Record<string, unknown>;
  };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface MeResponse {
  user: { id: string; email: string; name: string; platformRole: string | null };
  memberships: { tenantId: string; tenantName: string; tenantSlug: string; role: string }[];
  /** CASL rules; rebuild with abilityFromRules() for feature visibility. */
  rules: unknown[];
  /** Present when the caller authenticated with an API key. */
  apiKey?: { id: string; name: string; prefix: string; scopes: string[] };
}

export interface PlanDto {
  id: string;
  code: string;
  name: string;
  entitlements: Record<string, unknown>;
}

export interface TenantDto {
  id: string;
  name: string;
  slug: string;
  plan: { code: string; name: string };
  instanceCount: number;
  createdAt: string;
}

export interface TemplateVersionDto {
  id: string;
  version: string;
  status: 'DRAFT' | 'PUBLISHED' | 'DEPRECATED';
  source: string;
  document: Record<string, unknown>;
  validation: { valid: boolean; issues: ValidationIssueDto[] } | null;
  publishedAt: string | null;
  createdAt: string;
  instanceCount?: number;
}

export interface TemplateDto {
  id: string;
  name: string;
  displayName: string;
  description: string;
  visibility: 'SYSTEM' | 'ORGANIZATION';
  latestPublished: TemplateVersionDto | null;
  versions?: TemplateVersionDto[];
}

export interface ValidationIssueDto {
  stage: string;
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
  suggestions?: string[];
}

export interface CloudTargetDto {
  id: string;
  tenantId: string | null;
  provider: string;
  simulated: boolean;
  /** For simulated targets: which provider is being imitated. */
  simulates: string | null;
  name: string;
  environment: string;
  /** The default target of its tenant scope, provider and environment. */
  isDefault: boolean;
  config: Record<string, unknown>;
  hasCredentialRef: boolean;
  allowedRegions: string[];
  defaultRegion: string;
  status: 'ACTIVE' | 'DISABLED';
  health: string;
  lastValidation: { ok: boolean; checks: { name: string; status: string; message: string }[]; validatedAt: string; identity?: string } | null;
  lastValidatedAt: string | null;
}

export interface CapabilityDto {
  provider: string;
  serviceKind: string;
  capability: string;
  displayName: string;
  isDefault: boolean;
  features: string[];
  limitations: string[];
}

export interface ResourceDto {
  resourceId: string;
  type: string;
  slot: string;
  provider: string;
  simulatedProvider: string | null;
  targetId: string;
  region: string;
  capability: string;
  capabilityName: string;
  name: string;
  critical: boolean;
  providerResourceId: string | null;
  outputs: Record<string, unknown>;
  status: 'PENDING' | 'ACTIVE' | 'FAILED' | 'DELETED';
  knowledge: 'DESIRED' | 'KNOWN' | 'ACTUAL' | 'UNKNOWN';
  health: string;
  healthMessage: string | null;
  healthCheckedAt: string | null;
  drift: string;
  driftCheckedAt: string | null;
  /** From the last drift scan: what the provider would change to restore the applied configuration. */
  driftChanges: { address: string; action: string }[];
}

export interface InstanceDto {
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  slug: string;
  environment: string;
  status: string;
  health: string;
  simulated: boolean;
  template: { id: string; name: string; displayName: string; version: string; versionId: string };
  variables: Record<string, unknown>;
  bindings: Record<string, { targetId: string; region: string }>;
  protectedFromDestroy: boolean;
  createdAt: string;
  updatedAt: string;
  resources?: ResourceDto[];
  lastDeployment?: DeploymentSummaryDto | null;
}

export interface PreviewDto {
  valid: boolean;
  issues: ValidationIssueDto[];
  resources: {
    id: string;
    type: string;
    slot: string;
    provider: string;
    simulatedProvider: string | null;
    targetName: string;
    region: string;
    capability: string;
    capabilityName: string;
    name: string;
    dependsOn: string[];
  }[];
  levels: string[][];
  connectivity: { from: string; to: string; protocol: string; mode: string; strategy: string; crossCloud: boolean; notes: string[] }[];
  policyResults: { policy: string; status: 'pass' | 'fail' | 'warn'; message: string; resourceId?: string }[];
  cost: {
    currency: string;
    total: number;
    confidence: string;
    lines: { resourceId: string; category: string; provider: string; monthly: number | null; source: string }[];
  };
  plan: {
    counts: Record<'CREATE' | 'UPDATE' | 'DELETE' | 'NOOP', number>;
    risk: 'low' | 'medium' | 'high';
    groups: { provider: string; targetName: string; region: string; changes: { resourceId: string; action: string; capabilityName: string; replacement: boolean }[] }[];
    crossCloud: string[];
    text: string;
  };
  simulated: boolean;
}

export interface DeploymentSummaryDto {
  id: string;
  instanceId: string;
  tenantId: string;
  kind: 'APPLY' | 'DESTROY';
  status: string;
  simulated: boolean;
  correlationId: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorClass: string | null;
  errorMessage: string | null;
}

export interface DeploymentStepDto {
  key: string;
  kind: 'PHASE' | 'RESOURCE';
  name: string;
  position: number;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'CANCELLED';
  attempt: number;
  provider: string | null;
  region: string | null;
  errorClass: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DeploymentDto extends DeploymentSummaryDto {
  instanceName: string;
  approvalRequired: boolean;
  steps: DeploymentStepDto[];
  plan: PreviewDto['plan'] | null;
  cost: PreviewDto['cost'] | null;
  outputs: Record<string, Record<string, unknown>> | null;
}

export interface DeploymentEventDto {
  id: string;
  at: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  stepKey: string | null;
  message: string;
}

export interface IncidentDto {
  id: string;
  tenantId: string;
  instanceId: string | null;
  title: string;
  status: 'INVESTIGATING' | 'IDENTIFIED' | 'MONITORING' | 'RESOLVED';
  impact: string;
  severity: string;
  source: 'MANUAL' | 'AUTOMATED';
  openedAt: string;
  resolvedAt: string | null;
  updates?: { id: string; status: string; message: string; at: string }[];
}

export interface StatusPageDto {
  tenant: { id: string; name: string };
  overall: string;
  instances: {
    id: string;
    name: string;
    status: string;
    simulated: boolean;
    components: { id: string; name: string; status: string }[];
  }[];
  openIncidents: IncidentDto[];
  recentIncidents: IncidentDto[];
  recentActivity: { at: string; message: string; kind: string }[];
}

export interface NotificationDto {
  id: string;
  event: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface AuditEventDto {
  id: string;
  at: string;
  actorType: string;
  actorLabel: string | null;
  tenantId: string | null;
  resourceType: string;
  resourceId: string | null;
  action: string;
  result: string;
  correlationId: string | null;
  changes: Record<string, unknown> | null;
}

export interface ApplicationDto {
  id: string;
  name: string;
  displayName: string;
  registryKind: string;
  repository: string;
  port: number;
  healthPath: string;
  versions: { version: string; imageUri: string; digest: string; architectures: string[]; scanStatus: string }[];
}

export interface OverviewDto {
  tenants: number;
  instances: number;
  instancesByStatus: Record<string, number>;
  unhealthyResources: number;
  openIncidents: number;
  deployments24h: { total: number; failed: number };
  targets: { id: string; name: string; provider: string; health: string }[];
  providerDistribution: Record<string, number>;
  estimatedMonthlyCost: number;
  recentAudit: AuditEventDto[];
}

export interface TriggerParamDto {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  description?: string;
}

/** A template trigger as it applies to one deployed instance. */
export interface TriggerDto {
  name: string;
  description: string | null;
  resourceId: string;
  action: string;
  params: Record<string, string | number | boolean>;
  overridable: string[];
  on: { manual: boolean; webhook: boolean; schedule: string | null };
  /** False when the resource is not deployed or its provider does not offer the action. */
  available: boolean;
  unavailableReason: string | null;
  /** Parameters the provider accepts for this action. */
  actionParams: TriggerParamDto[];
  provider: string | null;
  lastRun: TriggerRunDto | null;
}

export interface TriggerRunDto {
  id: string;
  instanceId: string;
  trigger: string;
  resourceId: string;
  action: string;
  params: Record<string, string | number | boolean>;
  source: 'MANUAL' | 'SCHEDULE' | 'WEBHOOK';
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  reference: string | null;
  url: string | null;
  message: string | null;
  errorClass: string | null;
  queuedAt: string;
  finishedAt: string | null;
}

export interface FeatureFlagDto {
  key: string;
  category: 'provider' | 'feature';
  description: string;
  provider: string | null;
  defaultEnabled: boolean;
  /** Platform wide override, or null when the default applies. */
  platform: boolean | null;
  /** Overrides for single tenants. */
  tenants: { tenantId: string; tenantName: string; enabled: boolean }[];
  /** Value for the whole platform (default or platform override). */
  enabled: boolean;
}

export interface ProviderDto {
  provider: string;
  displayName: string;
  kind: 'infrastructure' | 'platform' | 'simulation';
  simulated: boolean;
  /** False when the provider's feature flag is off for the caller's scope. */
  enabled: boolean;
}
