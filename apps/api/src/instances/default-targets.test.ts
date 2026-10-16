// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { type DefaultCandidate, pickDefaultBindings } from './default-targets.js';

const t = (id: string, o: Partial<DefaultCandidate> = {}): DefaultCandidate => ({
  id,
  provider: 'aws',
  tenantId: null,
  environment: 'production',
  defaultRegion: 'us-east-1',
  isDefault: true,
  status: 'ACTIVE',
  ...o,
});

describe('pickDefaultBindings', () => {
  const slots = [{ name: 'primary', providers: ['aws', 'azure'] }];

  it('binds an unbound slot to the default of the instance environment', () => {
    const picked = pickDefaultBindings(slots, {}, 'staging', 'tenant-1', [t('prod'), t('staging', { environment: 'staging', defaultRegion: 'eu-west-1' })]);
    expect(picked).toEqual({ primary: { targetId: 'staging', region: 'eu-west-1' } });
  });

  it('never picks a target of another environment, a disabled one, or one that is not a default', () => {
    const candidates = [t('prod'), t('off', { environment: 'development', status: 'DISABLED' }), t('plain', { environment: 'development', isDefault: false })];
    expect(pickDefaultBindings(slots, {}, 'development', 'tenant-1', candidates)).toEqual({});
  });

  it('prefers the tenant own target, then the exact environment over any, then the slot provider order', () => {
    const shared = t('shared', { environment: 'development' });
    const own = t('own', { tenantId: 'tenant-1', environment: 'any' });
    expect(pickDefaultBindings(slots, {}, 'development', 'tenant-1', [shared, own]).primary?.targetId).toBe('own');
    const anyEnv = t('any', { environment: 'any' });
    expect(pickDefaultBindings(slots, {}, 'development', 'tenant-1', [anyEnv, shared]).primary?.targetId).toBe('shared');
    const azure = t('azure', { provider: 'azure', environment: 'development' });
    expect(pickDefaultBindings(slots, {}, 'development', 'tenant-1', [azure, shared]).primary?.targetId).toBe('shared');
  });

  it('keeps explicit bindings, ignores other tenants and providers the slot does not accept', () => {
    const other = t('other', { tenantId: 'tenant-2', environment: 'development' });
    const gcp = t('gcp', { provider: 'gcp', environment: 'development' });
    expect(pickDefaultBindings(slots, { primary: { targetId: 'x', region: 'y' } }, 'development', 'tenant-1', [t('d', { environment: 'development' })])).toEqual({});
    expect(pickDefaultBindings(slots, {}, 'development', 'tenant-1', [other, gcp])).toEqual({});
  });
});
