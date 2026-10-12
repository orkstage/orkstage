// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { HttpError, ProviderError, redact } from '@orkstage/cloud-core';

/** What signs OCI API requests: the API key of one user in one tenancy. */
export interface OciSigningKey {
  tenancyOcid: string;
  userOcid: string;
  fingerprint: string;
  /** PEM (PKCS#1 or PKCS#8), unencrypted. */
  privateKey: string;
}

export interface SignableRequest {
  method: string;
  url: string;
  /** Request body; methods with a body (POST, PUT, PATCH) always sign content headers. */
  body?: string;
  contentType?: string;
  /** Fixed clock for tests. */
  date?: Date;
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Parses the PEM once, with an error that never echoes key material. */
export function parsePrivateKey(pem: string): KeyObject {
  try {
    return createPrivateKey({ key: pem.replace(/\\n/g, '\n'), format: 'pem' });
  } catch {
    throw new ProviderError('OCI_PRIVATE_KEY_INVALID', 'privateKey is not a readable unencrypted PEM private key.', 'AUTHENTICATION_ERROR', 'oci');
  }
}

/** The lines OCI signs, in header order, and the header list for the Authorization value. */
export function signingString(headers: Record<string, string>, names: string[]): string {
  return names.map((n) => `${n}: ${headers[n]}`).join('\n');
}

/**
 * Signs a request with the OCI HTTP Signature scheme (draft cavage, rsa-sha256). Returns every
 * header to send, including `authorization`. `host` and `content-length` are part of the
 * signature but are set by the HTTP client itself; `ociFetch` leaves them out on purpose.
 */
export function signRequest(key: OciSigningKey, req: SignableRequest, keyObject: KeyObject = parsePrivateKey(key.privateKey)): Record<string, string> {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const headers: Record<string, string> = {
    date: (req.date ?? new Date()).toUTCString(),
    '(request-target)': `${method.toLowerCase()} ${url.pathname}${url.search}`,
    host: url.host,
  };
  const names = ['date', '(request-target)', 'host'];
  if (BODY_METHODS.has(method)) {
    const body = req.body ?? '';
    headers['content-length'] = String(Buffer.byteLength(body));
    headers['content-type'] = req.contentType ?? 'application/json';
    headers['x-content-sha256'] = createHash('sha256').update(body).digest('base64');
    names.push('content-length', 'content-type', 'x-content-sha256');
  }
  const signature = createSign('RSA-SHA256').update(signingString(headers, names)).sign(keyObject, 'base64');
  const keyId = `${key.tenancyOcid}/${key.userOcid}/${key.fingerprint}`;
  const { '(request-target)': _target, ...out } = headers;
  return {
    ...out,
    authorization: `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${names.join(' ')}",signature="${signature}"`,
  };
}

/** Signed HTTP client for OCI REST APIs. */
export class OciClient {
  private readonly keyObject: KeyObject;

  constructor(
    private readonly key: OciSigningKey,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.keyObject = parsePrivateKey(key.privateKey);
  }

  /** Raw signed request; the caller reads the status and body. */
  async request(method: string, url: string, opts: { body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Response> {
    const body = opts.body === undefined ? (BODY_METHODS.has(method.toUpperCase()) ? '' : undefined) : JSON.stringify(opts.body);
    const signed = signRequest(this.key, { method, url, body }, this.keyObject);
    const { host: _host, 'content-length': _length, ...headers } = signed;
    const signal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 20_000), ...(opts.signal ? [opts.signal] : [])]);
    return this.fetchFn(url, { method, headers: { ...headers, accept: 'application/json' }, body, signal });
  }

  /** Signed JSON request; `null` for a 404 when `allow404` is set. Errors are redacted. */
  async json<T>(method: string, url: string, opts: { body?: unknown; signal?: AbortSignal; allow404?: boolean } = {}): Promise<T | null> {
    const res = await this.request(method, url, opts);
    if (res.status === 404 && opts.allow404) return null;
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} from ${new URL(url).host}: ${redact(text, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
}
