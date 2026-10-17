// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { abilityFromRules, defineAbilityFor, subject } from './index.js';

const acmeInstance = subject('Instance', { id: 'i1', tenantId: 'acme' });
const globexInstance = subject('Instance', { id: 'i2', tenantId: 'globex' });

describe('platform roles', () => {
  it('owner can do everything', () => {
    const a = defineAbilityFor({ userId: 'u', platformRole: 'PlatformOwner', memberships: [] });
    expect(a.can('manage', 'Settings')).toBe(true);
    expect(a.can('destroy', globexInstance)).toBe(true);
  });

  it('admin cannot change global settings', () => {
    const a = defineAbilityFor({ userId: 'u', platformRole: 'PlatformAdmin', memberships: [] });
    expect(a.can('update', 'Settings')).toBe(false);
    expect(a.can('read', 'Settings')).toBe(true);
    expect(a.can('manage', 'CloudTarget')).toBe(true);
  });

  it('operator can deploy but not manage cloud targets or publish templates', () => {
    const a = defineAbilityFor({ userId: 'u', platformRole: 'PlatformOperator', memberships: [] });
    expect(a.can('deploy', acmeInstance)).toBe(true);
    expect(a.can('create', 'CloudTarget')).toBe(false);
    expect(a.can('publish', 'Template')).toBe(false);
    expect(a.can('destroy', acmeInstance)).toBe(false);
  });
});

describe('tenant isolation', () => {
  const dev = defineAbilityFor({ userId: 'u', memberships: [{ tenantId: 'acme', role: 'CustomerDeveloper' }] });

  it('allows actions inside the member tenant only', () => {
    expect(dev.can('read', acmeInstance)).toBe(true);
    expect(dev.can('deploy', acmeInstance)).toBe(true);
    expect(dev.can('read', globexInstance)).toBe(false);
    expect(dev.can('deploy', globexInstance)).toBe(false);
  });

  it('developers cannot destroy; admins can', () => {
    expect(dev.can('destroy', acmeInstance)).toBe(false);
    const admin = defineAbilityFor({ userId: 'u', memberships: [{ tenantId: 'acme', role: 'CustomerAdmin' }] });
    expect(admin.can('destroy', acmeInstance)).toBe(true);
    expect(admin.can('destroy', globexInstance)).toBe(false);
  });

  it('viewers are read-only', () => {
    const viewer = defineAbilityFor({ userId: 'u', memberships: [{ tenantId: 'acme', role: 'CustomerViewer' }] });
    expect(viewer.can('read', acmeInstance)).toBe(true);
    expect(viewer.can('deploy', acmeInstance)).toBe(false);
  });

  it('customers never get cloud-target or settings access', () => {
    const owner = defineAbilityFor({ userId: 'u', memberships: [{ tenantId: 'acme', role: 'CustomerOwner' }] });
    expect(owner.can('read', 'CloudTarget')).toBe(false);
    expect(owner.can('read', 'Settings')).toBe(false);
    expect(owner.can('publish', 'Template')).toBe(false);
  });

  it('roles apply per tenant', () => {
    const mixed = defineAbilityFor({
      userId: 'u',
      memberships: [
        { tenantId: 'acme', role: 'CustomerAdmin' },
        { tenantId: 'globex', role: 'CustomerViewer' },
      ],
    });
    expect(mixed.can('destroy', acmeInstance)).toBe(true);
    expect(mixed.can('destroy', globexInstance)).toBe(false);
    expect(mixed.can('read', globexInstance)).toBe(true);
  });

  it('lets tenant admins manage only their own keys and webhooks', () => {
    const admin = defineAbilityFor({ userId: 'u', memberships: [{ tenantId: 'acme', role: 'CustomerAdmin' }] });
    expect(admin.can('create', subject('ApiKey', { tenantId: 'acme' }))).toBe(true);
    expect(admin.can('create', subject('ApiKey', { tenantId: 'globex' }))).toBe(false);
    expect(admin.can('create', subject('Webhook', { tenantId: null }))).toBe(false);
    expect(dev.can('create', subject('ApiKey', { tenantId: 'acme' }))).toBe(false);
    expect(dev.can('create', subject('Import', { tenantId: 'acme' }))).toBe(true);
  });

  it('serialized rules rebuild an equivalent ability for the frontend', () => {
    const rebuilt = abilityFromRules(JSON.parse(JSON.stringify(dev.rules)));
    expect(rebuilt.can('deploy', acmeInstance)).toBe(true);
    expect(rebuilt.can('deploy', globexInstance)).toBe(false);
  });
});

describe('marketplace', () => {
  it('everyone signed in can browse; only platform admins and owners review; operators cannot submit', () => {
    const customer = defineAbilityFor({ userId: 'u', platformRole: null, memberships: [{ tenantId: 't1', role: 'CustomerViewer' }] } as never);
    const operator = defineAbilityFor({ userId: 'o', platformRole: 'PlatformOperator', memberships: [] } as never);
    const admin = defineAbilityFor({ userId: 'a', platformRole: 'PlatformAdmin', memberships: [] } as never);
    expect(customer.can('read', 'Marketplace')).toBe(true);
    expect(customer.can('approve', 'Marketplace')).toBe(false);
    expect(operator.can('read', 'Marketplace')).toBe(true);
    expect(operator.can('approve', 'Marketplace')).toBe(false);
    expect(operator.can('publish', 'Template')).toBe(false);
    expect(admin.can('approve', 'Marketplace')).toBe(true);
    expect(admin.can('publish', 'Template')).toBe(true);
  });
});

describe('tenant members', () => {
  it('every member reads the team; only owners manage it; only admins read the audit log', () => {
    const viewer = defineAbilityFor({ userId: 'v', platformRole: null, memberships: [{ tenantId: 'acme', role: 'CustomerViewer' }] } as never);
    const owner = defineAbilityFor({ userId: 'o', platformRole: null, memberships: [{ tenantId: 'acme', role: 'CustomerOwner' }] } as never);
    expect(viewer.can('read', subject('Member', { tenantId: 'acme' }))).toBe(true);
    expect(viewer.can('read', subject('Member', { tenantId: 'globex' }))).toBe(false);
    expect(viewer.can('create', subject('Member', { tenantId: 'acme' }))).toBe(false);
    expect(viewer.can('read', subject('Audit', { tenantId: 'acme' }))).toBe(false);
    expect(owner.can('create', subject('Member', { tenantId: 'acme' }))).toBe(true);
  });
});

describe('profiles (ADR 0007)', () => {
  const own = subject('Profile', { tenantId: 'acme' });
  const shared = subject('Profile', { tenantId: null });
  const other = subject('Profile', { tenantId: 'globex' });

  it('members read their tenant and shared profiles; they do not manage them', () => {
    const viewer = defineAbilityFor({ userId: 'v', memberships: [{ tenantId: 'acme', role: 'CustomerViewer' }] });
    const admin = defineAbilityFor({ userId: 'a', memberships: [{ tenantId: 'acme', role: 'CustomerAdmin' }] });
    expect([viewer.can('read', own), viewer.can('read', shared), viewer.can('read', other)]).toEqual([true, true, false]);
    expect(viewer.can('update', own)).toBe(false);
    expect([admin.can('create', own), admin.can('update', shared), admin.can('delete', other)]).toEqual([false, false, false]);
  });

  it('platform admins manage shared profiles; operators only read them', () => {
    const admin = defineAbilityFor({ userId: 'p', platformRole: 'PlatformAdmin', memberships: [] });
    const operator = defineAbilityFor({ userId: 'o', platformRole: 'PlatformOperator', memberships: [] });
    expect(admin.can('create', shared)).toBe(true);
    expect([operator.can('read', shared), operator.can('update', shared)]).toEqual([true, false]);
  });
});
