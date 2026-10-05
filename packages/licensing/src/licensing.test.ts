import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assembleLicenseKey, licenseSigningInput, Licensing, type LicensePayload } from './index.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function issue(over: Partial<LicensePayload> = {}, key = privateKey): string {
  const payload: LicensePayload = {
    id: 'lic_1',
    customer: 'Acme Corp',
    edition: 'enterprise',
    features: ['audit.export', 'auth.saml'],
    issuedAt: '2026-10-01T00:00:00Z',
    expiresAt: '2027-10-01T00:00:00Z',
    ...over,
  };
  const { encoded, message } = licenseSigningInput(payload);
  return assembleLicenseKey(encoded, sign(null, message, key));
}

const now = new Date('2027-01-01T00:00:00Z');

describe('Licensing', () => {
  it('is Community without a key', () => {
    const l = new Licensing(undefined, pub, now);
    expect(l.state.status).toBe('community');
    expect(l.has('audit.export')).toBe(false);
  });

  it('activates licensed features only', () => {
    const l = new Licensing(issue(), pub, now);
    expect(l.state).toMatchObject({ status: 'active', edition: 'enterprise', customer: 'Acme Corp' });
    expect(l.has('audit.export')).toBe(true);
    expect(l.has('auth.scim')).toBe(false);
  });

  it('rejects tampered payloads and foreign signatures', () => {
    const key = issue();
    const [prefix, payload, sig] = [key.slice(0, 20), key.split('.')[2]!, key.split('.')[3]!];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), features: ['rbac.custom-roles'] })).toString('base64url');
    expect(new Licensing(`${prefix}${forged}.${sig}`, pub, now).state.status).toBe('invalid');
    const other = generateKeyPairSync('ed25519').privateKey;
    expect(new Licensing(issue({}, other), pub, now).state.status).toBe('invalid');
    expect(new Licensing('not-a-license', pub, now).state.status).toBe('invalid');
  });

  it('keeps features during the grace period, then disables them', () => {
    const key = issue({ expiresAt: '2026-12-25T00:00:00Z' });
    const grace = new Licensing(key, pub, now);
    expect(grace.state.status).toBe('grace');
    expect(grace.has('audit.export')).toBe(true);
    const expired = new Licensing(key, pub, new Date('2027-02-01T00:00:00Z'));
    expect(expired.state.status).toBe('expired');
    expect(expired.has('audit.export')).toBe(false);
  });

  it('ignores unknown feature names', () => {
    const l = new Licensing(issue({ features: ['audit.export', 'free.lunch' as never] }), pub, now);
    expect(l.state.features).toEqual(['audit.export']);
  });
});
