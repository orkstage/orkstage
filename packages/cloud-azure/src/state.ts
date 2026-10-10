import { redact } from '@orkstage/cloud-core';
import type { StateStore } from '@orkstage/cloud-tofu';

/** Blob service version sent on every request (Microsoft Entra auth needs 2017-11-09 or later). */
export const BLOB_API_VERSION = '2024-11-04';

export interface BlobStateStoreOptions {
  account: string;
  container: string;
  /** Bearer token for https://storage.azure.com, fetched on demand. */
  token: () => Promise<string>;
  fetch: typeof fetch;
}

/**
 * OpenTofu state in an Azure Blob container, read through the Blob REST API with a Microsoft
 * Entra token (the service principal needs Storage Blob Data Contributor on the container).
 * The same container the `azurerm` backend writes to.
 */
export class AzureBlobStateStore implements StateStore {
  readonly location: string;

  constructor(private readonly opts: BlobStateStoreOptions) {
    this.location = `azure blob ${opts.account}/${opts.container}`;
  }

  private base(): string {
    return `https://${this.opts.account}.blob.core.windows.net/${this.opts.container}`;
  }

  private blobUrl(key: string): string {
    return `${this.base()}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async send(url: string, init: { method: string; body?: string; headers?: Record<string, string> }, signal?: AbortSignal): Promise<Response> {
    return this.opts.fetch(url, {
      method: init.method,
      body: init.body,
      headers: { authorization: `Bearer ${await this.opts.token()}`, 'x-ms-version': BLOB_API_VERSION, ...init.headers },
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
    });
  }

  private async fail(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? res.headers.get('x-ms-error-code') ?? '';
    throw new Error(`Blob ${what} failed: HTTP ${res.status}${code ? ` ${redact(code, 80)}` : ''}`);
  }

  async check(signal?: AbortSignal): Promise<void> {
    const res = await this.send(`${this.base()}?restype=container`, { method: 'GET' }, signal);
    if (!res.ok) await this.fail(res, 'container check');
  }

  async get(key: string, signal?: AbortSignal): Promise<string | null> {
    const res = await this.send(this.blobUrl(key), { method: 'GET' }, signal);
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res, 'read');
    return res.text();
  }

  async put(key: string, body: string, signal?: AbortSignal): Promise<void> {
    const res = await this.send(this.blobUrl(key), { method: 'PUT', body, headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/json' } }, signal);
    if (!res.ok) await this.fail(res, 'write');
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    const res = await this.send(this.blobUrl(key), { method: 'DELETE' }, signal);
    if (!res.ok && res.status !== 404) await this.fail(res, 'delete');
  }
}
