// SPDX-License-Identifier: AGPL-3.0-only
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
  'TenantLimits',
  'Instance',
  'Deployment',
  'Service',
  'Template',
  'Application',
  'CloudTarget',
  'Profile',
  'Incident',
  'AlertRule',
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
  // Register, edit and validate cloud targets (the `ork targets` commands). Platform keys only:
  // tenant roles cannot manage targets.
  'targets:manage',
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
    can('read', ['Template', 'TenantLimits', 'Application', 'Marketplace']);
    can(['deploy', 'restart'], 'Instance', ops);
    can('deploy', 'Service', ops);
    can(['create', 'update', 'scale', 'destroy', 'approve'], 'Instance', admins);
    // Every member sees who else is in the tenant; the audit log stays with owners and admins.
    can('read', 'Member', all);
    can('read', 'Audit', admins);
    can(['create', 'update', 'delete'], 'Member', owners);
    can('update', 'Tenant', owners);
    // Alert rules: every member sees what can open an incident; owners and admins change their tenant's.
    can('read', 'AlertRule', all);
    can('read', 'AlertRule', { tenantId: null });
    can(['create', 'update', 'delete'], 'AlertRule', admins);
    // Integrations: tenant admins manage their tenant's keys and webhooks; developers can import IaC.
    can('manage', ['ApiKey', 'Webhook'], admins);
    // Profiles (ADR 0007): every member reads the tenant's and the shared ones, and creates
    // instances from them. Platform staff manage them, as they manage the cloud targets that
    // tenant roles never see.
    can('read', 'Profile', all);
    can('read', 'Profile', { tenantId: null });
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
