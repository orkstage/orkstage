// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { resolveCapability, type CloudCapability } from './index.js';

const pg = (overrides: Partial<CloudCapability>): CloudCapability => ({
  provider: 'azure',
  serviceKind: 'database.postgresql',
  capability: 'flexible-server',
  displayName: 'Azure Database for PostgreSQL Flexible Server',
  regions: ['eastus', 'westeurope', 'brazilsouth'],
  features: ['ha:same-zone', 'ha:zone-redundant', 'backup'],
  regionalGaps: { brazilsouth: ['ha:zone-redundant'] },
  supportsEncryption: true,
  supportsBackup: true,
  isDefault: true,
  ...overrides,
});

describe('resolveCapability', () => {
  it('picks the default implementation when none is requested', () => {
    const r = resolveCapability([pg({})], { serviceKind: 'database.postgresql', features: [], region: 'eastus' });
    expect(r.ok && r.capability.capability).toBe('flexible-server');
  });

  it('explains regional feature gaps with alternatives (spec §42.6)', () => {
    const r = resolveCapability([pg({})], {
      serviceKind: 'database.postgresql',
      features: ['ha:zone-redundant'],
      region: 'brazilsouth',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/does not support: ha:zone-redundant/);
      expect(r.suggestions).toEqual(expect.arrayContaining(['Use same-zone high availability', 'Place this resource on another provider.']));
    }
  });

  it('rejects unknown implementations and lists the available ones', () => {
    const r = resolveCapability([pg({})], {
      serviceKind: 'database.postgresql',
      implementation: 'single-server',
      features: [],
      region: 'eastus',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.suggestions[0]).toMatch(/flexible-server/);
  });

  it('rejects resource kinds the provider does not offer', () => {
    const r = resolveCapability([pg({})], { serviceKind: 'queue', features: [], region: 'eastus' });
    expect(r.ok).toBe(false);
  });

  it('reports unavailable regions', () => {
    const r = resolveCapability([pg({})], { serviceKind: 'database.postgresql', features: [], region: 'mars-1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not available in mars-1/);
  });
});
