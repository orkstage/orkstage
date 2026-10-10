import { createHash } from 'node:crypto';
import { HttpError, ProviderError, TokenCache, failureClassForStatus, redact, requestJson } from '@orkstage/cloud-core';
import type { AzureCredentials, AzureTargetConfig } from './config.js';

/** OAuth scopes of the Azure APIs the adapter calls. */
export const SCOPES = {
  management: 'https://management.azure.com/.default',
  storage: 'https://storage.azure.com/.default',
  vault: 'https://vault.azure.net/.default',
  logs: 'https://api.loganalytics.io/.default',
} as const;

export const ARM = 'https://management.azure.com';

type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/**
 * Microsoft Entra client credentials flow for the target's service principal, with tokens
 * cached per tenant, client, secret and scope until shortly before they expire.
 */
export class AzureAuth {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly cache = new TokenCache(),
  ) {}

  token(cfg: AzureTargetConfig, creds: AzureCredentials, scope: Scope, signal?: AbortSignal): Promise<string> {
    // The secret takes part in the key (hashed) so a rotated secret never reuses an old token.
    const fingerprint = createHash('sha256').update(creds.clientSecret).digest('hex').slice(0, 16);
    return this.cache.get(`${cfg.tenantId}:${cfg.clientId}:${fingerprint}:${scope}`, async () => {
      const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: creds.clientSecret, scope });
      const res = await this.fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
      });
      const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number | string; error?: string; error_description?: string };
      if (!res.ok || !json.access_token) {
        const code = json.error ?? `HTTP ${res.status}`;
        // AADSTS descriptions carry trace and correlation ids; keep the first sentence only.
        const detail = redact(String(json.error_description ?? '').split(/\r?\n/)[0] ?? '', 200);
        throw new ProviderError('AZURE_TOKEN_FAILED', `Microsoft Entra rejected the service principal (${code}). ${detail}`.trim(), res.status >= 500 ? 'NETWORK_ERROR' : 'AUTHENTICATION_ERROR', 'azure');
      }
      return { value: json.access_token, expiresInSeconds: Number(json.expires_in ?? 3600) };
    });
  }
}

/** JSON request to an Azure API with a bearer token; maps HTTP failures to ProviderError. */
export async function azureJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal; allow404?: boolean } = {},
): Promise<T | null> {
  try {
    return await requestJson<T>(url, {
      fetch: fetchImpl,
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
      allow404: init.allow404,
    });
  } catch (err) {
    if (err instanceof HttpError) throw new ProviderError(`AZURE_HTTP_${err.status}`, err.message, failureClassForStatus(err.status), 'azure', { status: err.status });
    throw err;
  }
}
