import type { ApiErrorBody, Page } from '@co/contracts';

/**
 * Thin typed client for the control API. The browser always calls the relative `/api/v1`
 * path; Next rewrites it to the API so the httpOnly session cookie stays same-origin.
 * Nothing here stores tokens: authentication lives entirely in the cookie.
 */
export const API_BASE = '/api/v1';

export type MutatingMethod = 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type Method = 'GET' | MutatingMethod;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string | null;
  readonly requestId: string | null;
  readonly details: Record<string, unknown>;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    correlationId?: string | null;
    requestId?: string | null;
    details?: Record<string, unknown>;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.correlationId = init.correlationId ?? null;
    this.requestId = init.requestId ?? null;
    this.details = init.details ?? {};
  }
}

export function isApiError(err: unknown, status?: number): err is ApiError {
  return err instanceof ApiError && (status === undefined || err.status === status);
}

interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

async function request<T>(method: Method, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const mutating = method !== 'GET';
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (mutating) {
    headers['content-type'] = 'application/json';
    headers['x-co-csrf'] = '1';
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      headers,
      // A JSON content-type with an empty body is rejected by most servers; send `{}` instead.
      body: mutating ? JSON.stringify(body ?? {}) : undefined,
      signal: opts.signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'Cannot reach the control API. Check your connection and try again.' });
  }

  const correlationHeader = res.headers.get('x-correlation-id');
  const requestHeader = res.headers.get('x-request-id');

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let payload: unknown = undefined;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }

  if (!res.ok) {
    const body = (payload as Partial<ApiErrorBody> | undefined)?.error;
    throw new ApiError({
      status: res.status,
      code: body?.code ?? `HTTP_${res.status}`,
      message: body?.message ?? defaultMessage(res.status),
      correlationId: body?.correlationId ?? correlationHeader,
      requestId: body?.requestId ?? requestHeader,
      details: body?.details ?? {},
    });
  }
  return payload as T;
}

function defaultMessage(status: number): string {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You do not have permission to do this.';
  if (status === 404) return 'Not found.';
  if (status >= 500) return 'The control API failed to process the request.';
  return `Request failed (${status}).`;
}

export function apiGet<T>(path: string, opts?: RequestOptions): Promise<T> {
  return request<T>('GET', path, undefined, opts);
}

export function apiSend<T>(method: MutatingMethod, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  return request<T>(method, path, body, opts);
}

/** Builds a query string, skipping empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Lists may come as a bare array or as `Page<T>`; accept both. */
export function asItems<T>(data: T[] | Page<T> | { items?: T[] } | null | undefined): T[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return data.items ?? [];
}

/** True for paths that are safe to redirect to after login (same-origin, absolute path). */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (value.startsWith('/login') || value.startsWith('/api/')) return '/';
  return value;
}
