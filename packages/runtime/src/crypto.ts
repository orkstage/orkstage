// SPDX-License-Identifier: AGPL-3.0-only
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Application-level encryption for secrets the platform must read back (e.g. webhook signing
 * secrets). AES-256-GCM; key from ENCRYPTION_KEY (32 bytes, base64) or, in development, derived
 * from SESSION_SECRET with HKDF. Format: `v1:<iv>:<tag>:<ciphertext>` (base64url parts).
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(encryptionKey: string | undefined, sessionSecret: string) {
    if (encryptionKey) {
      const key = Buffer.from(encryptionKey, 'base64');
      if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
      this.key = key;
    } else {
      this.key = Buffer.from(hkdfSync('sha256', sessionSecret, 'orkstage', 'secret-box-v1', 32));
    }
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
  }

  /**
   * Deterministic secret for one purpose (e.g. `supabase:db:<target>:<name>`): the same input always
   * gives the same value, so a generated database password can be recomputed when it is needed
   * instead of being stored anywhere. Uses a subkey of its own, never the encryption key itself.
   * Rotating ENCRYPTION_KEY changes every derived value.
   */
  derive(purpose: string): string {
    const subkey = Buffer.from(hkdfSync('sha256', this.key, 'orkstage', 'derived-secrets-v1', 32));
    return createHmac('sha256', subkey).update(purpose).digest('base64url');
  }

  open(sealed: string): string {
    const [version, iv, tag, ct] = sealed.split(':');
    if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported sealed secret format.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Random URL-safe token. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
