import { AbilityBuilder, createMongoAbility, type MongoAbility, type RawRuleOf } from '@casl/ability';

/**
 * Shared between API (authoritative) and web (feature visibility only). Hiding a button is
 * never security; every action is re-checked on the server (spec §13).
 */

export const ACTIONS = ['manage', 'read', 'create', 'update', 'delete', 'deploy', 'destroy', 'restart', 'scale', 'publish', 'approve'] as const;
export type Action = (typeof ACTIONS)[number];

export const SUBJECTS = [
  'all',
  'Organization',
  'Tenant',
  'Member',
  'Plan',
  'Instance',
  'Deployment',
  'Service',
  'Template',
  'Application',
  'CloudTarget',
  'Incident',
  'StatusPage',
  'Notification',
  'Policy',
  'Settings',
  'Audit',
  'ApiKey',
  'Webhook',
  'Import',
  'Marketplace',
] as const;
export type SubjectName = (typeof SUBJECTS)[number];

/** A subject instance: anything tagged with its type and (when tenant-owned) its tenant. */
export interface SubjectRecord {
  __type: SubjectName;
  tenantId?: string | null;
  [key: string]: unknown;
}

export type Subject = SubjectName | SubjectRecord;
export type AppAbility = MongoAbility<[Action, Subject]>;
export type AppRule = RawRuleOf<AppAbility>;

export const PLATFORM_ROLES = ['PlatformOwner', 'PlatformAdmin', 'PlatformOperator'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const TENANT_ROLES = ['CustomerOwner', 'CustomerAdmin', 'CustomerDeveloper', 'CustomerViewer'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export interface Principal {
  userId: string;
  platformRole?: PlatformRole | null;
  memberships: { tenantId: string; role: TenantRole }[];
}

const detectSubjectType = (s: Subject) => (typeof s === 'string' ? s : s.__type);

/**
 * API key scopes (docs/specs/integration-api.md). A key can never exceed its role; scopes only
 * narrow it. Routes declare the scope they need; routes without one are closed to API keys.
 */
export const API_KEY_SCOPES = [
  'instances:read',
  'instances:write',
  'instances:deploy',
  'templates:read',
  'templates:write',
  'applications:write',
  'incidents:write',
  'imports:write',
  'webhooks:manage',
  'audit:read',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Roles an API key may act as. Platform roles are only for organization-wide keys. */
export const API_KEY_ROLES = ['PlatformAdmin', 'PlatformOperator', 'CustomerAdmin', 'CustomerDeveloper', 'CustomerViewer'] as const;
export type ApiKeyRole = (typeof API_KEY_ROLES)[number];

export function defineAbilityFor(principal: Principal): AppAbility {
  const { can, cannot, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

  switch (principal.platformRole) {
    case 'PlatformOwner':
      can('manage', 'all');
      break;
    case 'PlatformAdmin':
      can('manage', 'all');
      cannot('manage', 'Settings');
      can('read', 'Settings');
      cannot('delete', 'Organization');
      break;
    case 'PlatformOperator':
      can('read', 'all');
      cannot('read', 'Settings');
      can(['deploy', 'restart', 'scale', 'approve'], 'Instance');
      can(['create', 'update'], 'Incident');
      can('update', 'StatusPage');
      break;
    default:
      break;
  }

  const tenantsWith = (...roles: TenantRole[]) =>
    principal.memberships.filter((m) => roles.includes(m.role)).map((m) => m.tenantId);
  const scoped = (...roles: TenantRole[]) => ({ tenantId: { $in: tenantsWith(...roles) } });

  const all = scoped('CustomerOwner', 'CustomerAdmin', 'CustomerDeveloper', 'CustomerViewer');
  const ops = scoped('CustomerOwner', 'CustomerAdmin', 'CustomerDeveloper');
  const admins = scoped('CustomerOwner', 'CustomerAdmin');
  const owners = scoped('CustomerOwner');

  if (principal.memberships.length > 0) {
    can('read', ['Tenant', 'Instance', 'Deployment', 'Service', 'Incident', 'StatusPage', 'Notification'], all);
    can('read', ['Template', 'Plan', 'Application', 'Marketplace']);
    can(['deploy', 'restart'], 'Instance', ops);
    can('deploy', 'Service', ops);
    can(['create', 'update', 'scale', 'destroy', 'approve'], 'Instance', admins);
    can('read', ['Member', 'Audit'], admins);
    can(['create', 'update', 'delete'], 'Member', owners);
    can('update', 'Tenant', owners);
    // Integrations: tenant admins manage their tenant's keys and webhooks; developers can import IaC.
    can('manage', ['ApiKey', 'Webhook'], admins);
    can(['create', 'read'], 'Import', ops);
  }

  return build({ detectSubjectType });
}

/** Rebuilds an ability from rules sent by the API (frontend use). */
export function abilityFromRules(rules: AppRule[]): AppAbility {
  return createMongoAbility<AppAbility>(rules, { detectSubjectType });
}

/** Helper to tag a plain record as a CASL subject. */
export function subject<T extends Record<string, unknown>>(type: SubjectName, record: T): T & SubjectRecord {
  return { ...record, __type: type };
}
