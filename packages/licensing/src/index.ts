// SPDX-License-Identifier: AGPL-3.0-only
import { createPublicKey, verify, type KeyObject } from 'node:crypto';

/**
 * Offline license verification for OrkStage Enterprise (docs/OPEN_CORE.md §3). A license key is
 * `orkstage-license.v1.<base64url payload>.<base64url Ed25519 signature>`. Only the public key
 * ships with OrkStage; keys are issued by a private signing service.
 */

/** Enterprise features. Community never needs a key. */
export const ENTERPRISE_FEATURES = [
  'audit.export',
  'auth.saml',
  'auth.scim',
  'rbac.custom-roles',
  'approvals.multi-step',
  'policies.packs',
  'organizations.multiple',
  'status.white-label',
] as const;
export type EnterpriseFeature = (typeof ENTERPRISE_FEATURES)[number];

export interface LicensePayload {
  id: string;
  customer: string;
  edition: 'enterprise';
  features: EnterpriseFeature[];
  seats?: number;
  issuedAt: string;
  expiresAt: string;
}

export type LicenseStatus = 'community' | 'active' | 'grace' | 'expired' | 'invalid';

export interface LicenseState {
  status: LicenseStatus;
  edition: 'community' | 'enterprise';
  customer?: string;
  features: EnterpriseFeature[];
  expiresAt?: string;
  /** Human-readable reason, e.g. why a key was rejected. Never includes the key. */
  message: string;
}

const PREFIX = 'orkstage-license.v1.';
const GRACE_DAYS = 14;

/**
 * DEVELOPMENT public key. Replace with the production key from the private licensing service
 * before the first public release (tracked in docs/OPEN_CORE.md §8).
 */
export const ORKSTAGE_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEATIZnnDaQWmVDF/omkiokVq6sZojnca9i/yjQxxV21QM=
-----END PUBLIC KEY-----`;

export class Licensing {
  readonly state: LicenseState;

  constructor(licenseKey: string | undefined, publicKeyPem: string = ORKSTAGE_LICENSE_PUBLIC_KEY, now: Date = new Date()) {
    this.state = evaluate(licenseKey, createPublicKey(publicKeyPem), now);
  }

  has(feature: EnterpriseFeature): boolean {
    return (this.state.status === 'active' || this.state.status === 'grace') && this.state.features.includes(feature);
  }
}

function evaluate(key: string | undefined, publicKey: KeyObject, now: Date): LicenseState {
  const community: LicenseState = { status: 'community', edition: 'community', features: [], message: 'OrkStage Community (AGPL-3.0).' };
  if (!key?.trim()) return community;
  const invalid = (message: string): LicenseState => ({ ...community, status: 'invalid', message });

  const trimmed = key.trim();
  if (!trimmed.startsWith(PREFIX)) return invalid('Unrecognized license key format.');
  const [payloadB64, signatureB64, extra] = trimmed.slice(PREFIX.length).split('.');
  if (!payloadB64 || !signatureB64 || extra !== undefined) return invalid('Malformed license key.');

  const signed = Buffer.from(`${PREFIX}${payloadB64}`);
  let valid = false;
  try {
    valid = verify(null, signed, publicKey, Buffer.from(signatureB64, 'base64url'));
  } catch {
    valid = false;
  }
  if (!valid) return invalid('License signature is not valid.');

  let payload: LicensePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as LicensePayload;
  } catch {
    return invalid('License payload is not readable.');
  }
  const features = (payload.features ?? []).filter((f): f is EnterpriseFeature => (ENTERPRISE_FEATURES as readonly string[]).includes(f));
  const expires = new Date(payload.expiresAt);
  if (Number.isNaN(expires.getTime())) return invalid('License has no valid expiry.');

  const base = { edition: 'enterprise' as const, customer: payload.customer, features, expiresAt: payload.expiresAt };
  if (now <= expires) return { ...base, status: 'active', message: `OrkStage Enterprise licensed to ${payload.customer}.` };
  const graceEnd = new Date(expires.getTime() + GRACE_DAYS * 86_400_000);
  if (now <= graceEnd) {
    return { ...base, status: 'grace', message: `License expired on ${payload.expiresAt.slice(0, 10)}; Enterprise features stop on ${graceEnd.toISOString().slice(0, 10)}. Renew to keep them.` };
  }
  return { ...base, features: [], status: 'expired', message: 'License expired; Enterprise features are disabled. Your data is untouched.' };
}

/** Test/tooling helper: build the signed message for a payload (signing happens elsewhere). */
export function licenseSigningInput(payload: LicensePayload): { encoded: string; message: Buffer } {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { encoded, message: Buffer.from(`${PREFIX}${encoded}`) };
}

export function assembleLicenseKey(encodedPayload: string, signature: Buffer): string {
  return `${PREFIX}${encodedPayload}.${signature.toString('base64url')}`;
}
