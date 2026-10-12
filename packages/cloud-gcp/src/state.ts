// SPDX-License-Identifier: AGPL-3.0-only
import { HttpError, redact } from '@orkstage/cloud-core';
import type { StateStore } from '@orkstage/cloud-tofu';

const STORAGE = 'https://storage.googleapis.com';

/**
 * Object name for a state store key. The `gcs` backend treats its `prefix` as a folder and
 * writes the default workspace to `<prefix>/default.tfstate`. The adapter uses the state key
 * (`orkstage/<name>.tfstate`) as that prefix, so the state itself lives at
 * `orkstage/<name>.tfstate/default.tfstate` while the applied config and virtual outputs keep
 * their flat names (`orkstage/<name>.tfstate.config.json`, `.virtual.json`) beside it.
 */
export function gcsObjectName(key: string): string {
  return key.endsWith('.tfstate') ? `${key}/default.tfstate` : key;
}

/** `backend "gcs"` block. Credentials come from GOOGLE_CREDENTIALS in the runner environment. */
export function gcsBackend(bucket: string, stateKey: string) {
  return { gcs: { bucket, prefix: stateKey } };
}

/** OpenTofu state and applied configs in a GCS bucket, through the JSON API. */
export class GcsStateStore implements StateStore {
  readonly location: string;

  constructor(
    private readonly bucket: string,
    private readonly token: () => Promise<string>,
    private readonly fetchFn: typeof fetch,
  ) {
    this.location = `gs://${bucket}`;
  }

  async check(signal?: AbortSignal): Promise<void> {
    const res = await this.call(`${STORAGE}/storage/v1/b/${encodeURIComponent(this.bucket)}?fields=name`, { method: 'GET' }, signal);
    await this.ensureOk(res);
  }

  async get(key: string, signal?: AbortSignal): Promise<string | null> {
    const res = await this.call(this.objectUrl(key, '?alt=media'), { method: 'GET' }, signal);
    if (res.status === 404) return null;
    await this.ensureOk(res);
    return res.text();
  }

  async put(key: string, body: string, signal?: AbortSignal): Promise<void> {
    const url = `${STORAGE}/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeURIComponent(gcsObjectName(key))}`;
    const res = await this.call(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, signal);
    await this.ensureOk(res);
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    const res = await this.call(this.objectUrl(key, ''), { method: 'DELETE' }, signal);
    if (res.status === 404) return;
    await this.ensureOk(res);
  }

  private objectUrl(key: string, query: string): string {
    return `${STORAGE}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(gcsObjectName(key))}${query}`;
  }

  private async call(url: string, init: RequestInit & { headers?: Record<string, string> }, signal?: AbortSignal): Promise<Response> {
    const token = await this.token();
    return this.fetchFn(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}` },
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
    });
  }

  private async ensureOk(res: Response): Promise<void> {
    if (res.ok) return;
    throw new HttpError(res.status, `HTTP ${res.status} from storage.googleapis.com: ${redact(await res.text(), 300)}`);
  }
}
