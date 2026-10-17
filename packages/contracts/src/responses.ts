// SPDX-License-Identifier: AGPL-3.0-only
import type { ProviderForm } from './providers.js';
import type { TenantLimitsInput } from './requests.js';
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

export interface TenantDto {
  id: string;
  name: string;
  slug: string;
  /** Optional limits (ADR 0007); a missing field is no limit. */
  limits: TenantLimitsInput;
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
  config: Record<string, unknown>;
  hasCredentialRef: boolean;
  allowedRegions: string[];
  defaultRegion: string;
  /** Deployments that may run on this target at the same time. */
  maxConcurrentDeployments: number;
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

/** A profile (ADR 0007): the target and region per provider for one environment. */
export interface ProfileDto {
  id: string;
  /** Null when the profile is shared with every tenant. */
  tenantId: string | null;
  name: string;
  environment: string;
  isDefault: boolean;
  targets: { provider: string; targetId: string; targetName: string; region: string | null; defaultRegion: string }[];
  /** Instances created from it. */
  instanceCount: number;
  createdAt: string;
  updatedAt: string;
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
  /** The profile the unbound slots were bound from at creation (ADR 0007). */
  profile: { id: string; name: string } | null;
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

export interface AlertRuleDto {
  id: string;
  /** Null: a platform rule, applied to every tenant. */
  tenantId: string | null;
  name: string;
  condition:
    | { signal: 'health'; critical?: boolean; consecutiveFailures: number }
    | { signal: 'metric'; metric: string; resourceTypes?: string[]; operator: '>' | '>=' | '<' | '<='; threshold: number; windowMinutes: number; statistic: 'avg' | 'max' | 'min' };
  severity: string;
  actions: string[];
  cooldownSeconds: number;
  autoResolve: boolean;
  enabled: boolean;
  createdAt: string;
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
  /** Running and upcoming maintenance. */
  maintenance: MaintenanceDto[];
  page: { visibility: StatusVisibility; slug: string | null; title: string | null; description: string | null };
  /** Whether the signed in user gets email updates from this page. */
  subscribed: boolean;
}

export type StatusVisibility = 'PRIVATE' | 'CUSTOMER_ONLY' | 'PUBLIC';

export interface MaintenanceDto {
  id: string;
  tenantId: string;
  instanceId: string | null;
  instanceName: string | null;
  title: string;
  message: string | null;
  componentNames: string[];
  startsAt: string;
  endsAt: string;
  state: 'scheduled' | 'in_progress' | 'completed';
}

/** Status page settings for its owners and admins. */
export interface StatusPageSettingsDto {
  tenantId: string;
  visibility: StatusVisibility;
  slug: string | null;
  title: string | null;
  description: string | null;
  confirmedSubscribers: number;
  components: { id: string; instanceId: string; instanceName: string; name: string; label: string | null; hidden: boolean; sortOrder: number | null; status: string }[];
}

/** The public view of a status page: names and states only, nothing internal. */
export interface PublicStatusDto {
  title: string;
  description: string | null;
  overall: string;
  groups: { name: string; status: string; components: { name: string; status: string }[] }[];
  openIncidents: PublicIncidentDto[];
  recentIncidents: PublicIncidentDto[];
  maintenance: { title: string; message: string | null; componentNames: string[]; startsAt: string; endsAt: string; state: MaintenanceDto['state'] }[];
}

export interface PublicIncidentDto {
  id: string;
  title: string;
  status: IncidentDto['status'];
  impact: string;
  openedAt: string;
  resolvedAt: string | null;
  updates: { status: string; message: string; at: string }[];
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

/** One of the signed in person's sessions (`GET /me/sessions`). */
export interface SessionDto {
  id: string;
  /** How it signed in: `dev`, or the identity provider key (`entra`, `google`, `github`...). */
  method: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** The session making this request. */
  current: boolean;
}

export interface ProviderDto {
  provider: string;
  displayName: string;
  kind: 'infrastructure' | 'platform' | 'simulation';
  simulated: boolean;
  /** False when the provider's feature flag is off for the caller's scope. */
  enabled: boolean;
  /** What registering a target asks for (PROVIDER_FORMS), so clients such as the CLI need no copy. */
  form: ProviderForm;
}

/**
 * The feature keys an Enterprise license can grant (ENTERPRISE_FEATURES in @orkstage/licensing,
 * which is not browser safe; a test keeps both lists equal).
 */
export const ENTERPRISE_FEATURE_KEYS = [
  'audit.export',
  'auth.saml',
  'auth.scim',
  'rbac.custom-roles',
  'approvals.multi-step',
  'policies.packs',
  'organizations.multiple',
  'status.white-label',
] as const;
export type EnterpriseFeatureKey = (typeof ENTERPRISE_FEATURE_KEYS)[number];

/** `GET /license`: the edition and what the license grants. Never the key itself. */
export interface LicenseDto {
  edition: 'community' | 'enterprise';
  status: 'community' | 'active' | 'grace' | 'expired' | 'invalid';
  customer: string | null;
  features: EnterpriseFeatureKey[];
  expiresAt: string | null;
  message: string;
}
