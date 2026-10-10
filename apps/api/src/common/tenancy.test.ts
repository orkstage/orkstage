import { describe, expect, it } from 'vitest';
import { scopedToTenant, tenantScope } from './tenancy.js';

const customer = { platformRole: null, memberships: [{ tenantId: 'acme', role: 'CustomerViewer' }] } as never;
const staff = { platformRole: 'PlatformAdmin', memberships: [] } as never;

describe('tenant scoping', () => {
  it('limits customers to their tenants and leaves staff unrestricted', () => {
    expect(tenantScope(customer)).toEqual({ tenantId: { in: ['acme'] } });
    expect(tenantScope(staff)).toEqual({});
  });

  it('never lets a requested tenant replace the caller scope', () => {
    // Both conditions must hold: a customer asking for another tenant gets an empty result.
    expect(scopedToTenant(customer, 'globex')).toEqual({ AND: [{ tenantId: { in: ['acme'] } }, { tenantId: 'globex' }] });
    expect(scopedToTenant(customer)).toEqual({ AND: [{ tenantId: { in: ['acme'] } }, {}] });
    expect(scopedToTenant(staff, 'globex')).toEqual({ AND: [{}, { tenantId: 'globex' }] });
  });
});
