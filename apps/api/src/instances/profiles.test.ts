// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { bindFromProfile, defaultProfile, type ProfileTargetView, type ProfileView } from './profiles.js';

const target = (id: string, o: Partial<ProfileTargetView> = {}): ProfileTargetView => ({
  id,
  tenantId: null,
  environment: 'any',
  defaultRegion: 'us-east-1',
  status: 'ACTIVE',
  ...o,
});

const profile = (id: string, o: Partial<ProfileView> = {}): ProfileView => ({
  id,
  tenantId: null,
  environment: 'production',
  isDefault: true,
  targets: [{ provider: 'aws', region: null, target: target(`${id}-aws`) }],
  ...o,
});

describe('defaultProfile', () => {
  it("prefers the tenant's own, then the exact environment", () => {
    const shared = profile('shared');
    const sharedAny = profile('shared-any', { environment: 'any' });
    const ownAny = profile('own-any', { tenantId: 't1', environment: 'any' });
    const own = profile('own', { tenantId: 't1' });
    expect(defaultProfile([shared, sharedAny, ownAny, own], 't1', 'production')?.id).toBe('own');
    expect(defaultProfile([shared, sharedAny, ownAny], 't1', 'production')?.id).toBe('own-any');
    expect(defaultProfile([sharedAny, shared], 't1', 'production')?.id).toBe('shared');
    expect(defaultProfile([sharedAny, shared], 't1', 'staging')?.id).toBe('shared-any');
  });

  it("ignores profiles that are not defaults, belong to another tenant or serve another environment", () => {
    const candidates = [profile('plain', { isDefault: false }), profile('other', { tenantId: 't2' }), profile('dev', { environment: 'development' })];
    expect(defaultProfile(candidates, 't1', 'production')).toBeUndefined();
  });
});

describe('bindFromProfile', () => {
  const multi = profile('p', {
    targets: [
      { provider: 'azure', region: 'westeurope', target: target('az', { defaultRegion: 'eastus' }) },
      { provider: 'aws', region: null, target: target('aws', { defaultRegion: 'sa-east-1' }) },
    ],
  });

  it("follows the slot's provider order and uses the profile's region, else the target's default", () => {
    const slots = [
      { name: 'primary', providers: ['aws', 'azure'] },
      { name: 'data', providers: ['azure'] },
      { name: 'any', providers: [] },
    ];
    expect(bindFromProfile(slots, {}, multi, 't1', 'production')).toEqual({
      primary: { targetId: 'aws', region: 'sa-east-1' },
      data: { targetId: 'az', region: 'westeurope' },
      any: { targetId: 'az', region: 'westeurope' },
    });
  });

  it('keeps bound slots and leaves a slot unbound when the profile has none of its providers', () => {
    const slots = [
      { name: 'primary', providers: ['aws'] },
      { name: 'web', providers: ['vercel'] },
    ];
    expect(bindFromProfile(slots, { primary: { targetId: 'x', region: 'y' } }, multi, 't1', 'production')).toEqual({});
  });

  it('skips targets that are disabled, belong to another tenant or serve another environment', () => {
    const slots = [{ name: 'primary', providers: ['aws'] }];
    for (const bad of [target('t', { status: 'DISABLED' }), target('t', { tenantId: 't2' }), target('t', { environment: 'development' })]) {
      expect(bindFromProfile(slots, {}, profile('p', { targets: [{ provider: 'aws', region: null, target: bad }] }), 't1', 'production')).toEqual({});
    }
  });
});
