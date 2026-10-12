// SPDX-License-Identifier: AGPL-3.0-only
import { createSign } from 'node:crypto';
import { requestJson, TokenCache } from '@orkstage/cloud-core';
import type { GcpCredentials } from './config.js';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/**
 * Self signed JWT assertion (RS256) for the OAuth 2.0 JWT bearer grant. The audience is always
 * Google's token endpoint: a `token_uri` from the key file is ignored so a signed assertion is
 * never sent anywhere else.
 */
export function signAssertion(creds: GcpCredentials, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(creds.private_key_id ? { kid: creds.private_key_id } : {}) }));
  const claims = b64url(JSON.stringify({ iss: creds.client_email, scope: CLOUD_PLATFORM_SCOPE, aud: TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 }));
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(creds.private_key);
  return `${header}.${claims}.${b64url(signature)}`;
}

/** OAuth access tokens for service account keys, cached in memory until shortly before expiry. */
export class GcpTokenSource {
  private readonly cache = new TokenCache();

  constructor(private readonly fetchFn: typeof fetch) {}

  token(creds: GcpCredentials, signal?: AbortSignal): Promise<string> {
    return this.cache.get(`${creds.client_email}:${creds.private_key_id ?? ''}`, async () => {
      const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signAssertion(creds) });
      const r = await requestJson<{ access_token: string; expires_in?: number }>(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        fetch: this.fetchFn,
        signal,
      });
      return { value: r!.access_token, expiresInSeconds: r!.expires_in ?? 3600 };
    });
  }
}

/** Authorized JSON call to a Google Cloud REST API. */
export type GcpApi = <T>(url: string, init?: RequestInit & { allow404?: boolean }) => Promise<T | null>;

export function gcpApi(fetchFn: typeof fetch, token: string, signal?: AbortSignal): GcpApi {
  return (url, init = {}) =>
    requestJson(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) },
      fetch: fetchFn,
      signal,
    });
}
