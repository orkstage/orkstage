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
