// SPDX-License-Identifier: AGPL-3.0-only
import { ProviderError, type ProviderContext } from './types.js';
import type { CloudProvider } from '@orkstage/domain';

export type SecretResolver = (ref: string) => Promise<string>;

/**
 * Reads the target's credential secret. The secret behind `credentialRef` (env:// or aws-sm://)
 * is either a JSON object with the provider's fields, or a single string that becomes the field
 * named by `singleField` (e.g. an API token). Only the listed `required` fields are checked; the
 * values never leave this process except as runner environment variables for one command.
 */
export async function readCredentialFields<T extends Record<string, string>>(
  provider: CloudProvider,
  ctx: ProviderContext,
  resolve: SecretResolver,
  opts: { required: (keyof T & string)[]; singleField?: keyof T & string },
): Promise<T> {
  const ref = ctx.target.credentialRef;
  if (!ref) {
    throw new ProviderError(`${provider.toUpperCase()}_CREDENTIALS_MISSING`, 'This target has no credential reference. Set credentialRef to env://NAME or aws-sm://name.', 'AUTHENTICATION_ERROR', provider);
  }
  let raw: string;
  try {
    raw = await resolve(ref);
  } catch (err) {
    throw new ProviderError(`${provider.toUpperCase()}_CREDENTIALS_UNREADABLE`, (err as Error).message.slice(0, 200), 'AUTHENTICATION_ERROR', provider);
  }
  let fields: Record<string, unknown>;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      fields = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      throw new ProviderError(`${provider.toUpperCase()}_CREDENTIALS_INVALID`, 'The credential secret looks like JSON but does not parse.', 'AUTHENTICATION_ERROR', provider);
    }
  } else if (opts.singleField) {
    fields = { [opts.singleField]: trimmed };
  } else {
    throw new ProviderError(`${provider.toUpperCase()}_CREDENTIALS_INVALID`, `The credential secret must be a JSON object with: ${opts.required.join(', ')}.`, 'AUTHENTICATION_ERROR', provider);
  }
  const missing = opts.required.filter((k) => typeof fields[k] !== 'string' || !(fields[k] as string).length);
  if (missing.length) {
    throw new ProviderError(`${provider.toUpperCase()}_CREDENTIALS_INCOMPLETE`, `The credential secret is missing: ${missing.join(', ')}.`, 'AUTHENTICATION_ERROR', provider);
  }
  return fields as T;
}

/**
 * Short in-memory cache for values that are expensive to obtain (OAuth access tokens).
 * Entries expire a margin before their real expiry; nothing is persisted.
 */
export class TokenCache {
  private readonly entries = new Map<string, { value: string; expires: number }>();

  async get(key: string, fetchToken: () => Promise<{ value: string; expiresInSeconds: number }>): Promise<string> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const t = await fetchToken();
    this.entries.set(key, { value: t.value, expires: Date.now() + Math.max(0, t.expiresInSeconds - 300) * 1000 });
    return t.value;
  }
}
