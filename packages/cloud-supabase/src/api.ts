import { failureClassForStatus, ProviderError, redact } from '@orkstage/cloud-core';
import { apiUrl, MANAGEMENT_API } from './config.js';

/** Project lifecycle states reported by the Management API. */
export type ProjectStatus =
  | 'INACTIVE'
  | 'ACTIVE_HEALTHY'
  | 'ACTIVE_UNHEALTHY'
  | 'COMING_UP'
  | 'UNKNOWN'
  | 'GOING_DOWN'
  | 'INIT_FAILED'
  | 'REMOVED'
  | 'RESTORING'
  | 'UPGRADING'
  | 'PAUSING'
  | 'RESTORE_FAILED'
  | 'RESTARTING'
  | 'PAUSE_FAILED'
  | 'RESIZING';

export interface Project {
  ref: string;
  name: string;
  organization_slug?: string;
  organization_id?: string;
  region: string;
  status: ProjectStatus;
  database?: { host?: string; version?: string };
}

export interface Organization {
  id: string;
  slug?: string;
  name: string;
  plan?: string;
}

export interface ApiKey {
  name: string;
  type?: 'legacy' | 'publishable' | 'secret' | null;
  api_key?: string | null;
}

export interface PoolerConfig {
  database_type: 'PRIMARY' | 'READ_REPLICA';
  db_user: string;
  db_host: string;
  db_port: number;
  db_name: string;
  pool_mode?: 'transaction' | 'session';
}

export interface ServiceHealth {
  name: string;
  status: 'COMING_UP' | 'ACTIVE_HEALTHY' | 'UNHEALTHY';
  error?: string;
}

export interface Bucket {
  id: string;
  name: string;
  public: boolean;
}

/** Projects that are gone or on their way out: never matched, never reported as existing. */
export const GONE: ReadonlySet<ProjectStatus> = new Set(['REMOVED', 'GOING_DOWN']);

interface CallOptions {
  body?: unknown;
  /** Return null instead of failing when the resource does not exist. */
  allow404?: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** Pulls the human readable part out of a Supabase error body. */
function errorText(text: string): string {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const msg = j.message ?? j.msg ?? j.error_description ?? j.error;
    if (typeof msg === 'string') return msg;
  } catch {
    // not JSON: use the raw text
  }
  return text;
}

/** Storage answers a missing bucket with HTTP 400 and `statusCode: "404"` in older releases. */
function isNotFound(status: number, text: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  try {
    const j = JSON.parse(text) as { statusCode?: string | number; error?: string };
    return String(j.statusCode) === '404' || /not found/i.test(String(j.error ?? ''));
  } catch {
    return false;
  }
}

/**
 * Thin client for the Supabase Management API and a project's Storage API. Errors become
 * ProviderError with redacted text; tokens and keys travel only in headers.
 */
export class SupabaseApi {
  constructor(
    private readonly token: string,
    private readonly f: typeof fetch,
    private readonly signal?: AbortSignal,
  ) {}

  /** Calls `https://api.supabase.com<path>` with the target's token. */
  mgmt<T>(method: string, path: string, opts: CallOptions = {}): Promise<T | null> {
    return this.send<T>(method, `${MANAGEMENT_API}${path}`, path.split('?')[0]!, { ...opts, headers: { authorization: `Bearer ${this.token}`, ...opts.headers } });
  }

  /** Calls a project's Storage API (`https://<ref>.supabase.co/storage/v1<path>`) with a project key. */
  storage<T>(ref: string, key: string, method: string, path: string, opts: CallOptions = {}): Promise<T | null> {
    // Legacy service_role keys are JWTs and go in both headers; new secret keys only in `apikey`.
    const auth: Record<string, string> = key.startsWith('eyJ') ? { apikey: key, authorization: `Bearer ${key}` } : { apikey: key };
    return this.send<T>(method, `${apiUrl(ref)}/storage/v1${path}`, `storage ${path.split('?')[0]}`, { ...opts, headers: { ...auth, ...opts.headers } });
  }

  async listProjects(): Promise<Project[]> {
    return (await this.mgmt<Project[]>('GET', '/v1/projects')) ?? [];
  }

  getProject(ref: string): Promise<Project | null> {
    return this.mgmt<Project>('GET', `/v1/projects/${ref}`, { allow404: true });
  }

  async listOrganizations(): Promise<Organization[]> {
    return (await this.mgmt<Organization[]>('GET', '/v1/organizations')) ?? [];
  }

  getOrganization(slug: string): Promise<Organization | null> {
    return this.mgmt<Organization>('GET', `/v1/organizations/${encodeURIComponent(slug)}`, { allow404: true });
  }

  async apiKeys(ref: string): Promise<ApiKey[]> {
    return (await this.mgmt<ApiKey[]>('GET', `/v1/projects/${ref}/api-keys?reveal=true`)) ?? [];
  }

  /** Service role (legacy JWT) or secret key, plus the anon or publishable key. */
  async projectKeys(ref: string): Promise<{ serviceRoleKey: string; anonKey?: string }> {
    const keys = await this.apiKeys(ref);
    const pick = (legacy: string, type: ApiKey['type']) =>
      keys.find((k) => k.name === legacy && k.api_key)?.api_key ?? keys.find((k) => k.type === type && k.api_key)?.api_key ?? undefined;
    const serviceRoleKey = pick('service_role', 'secret');
    if (!serviceRoleKey) {
      throw new ProviderError('SUPABASE_KEY_UNAVAILABLE', `Project ${ref} has no service role or secret API key visible to this token.`, 'AUTHORIZATION_ERROR', 'supabase');
    }
    return { serviceRoleKey, anonKey: pick('anon', 'publishable') };
  }

  async pooler(ref: string): Promise<PoolerConfig | undefined> {
    const list = (await this.mgmt<PoolerConfig[]>('GET', `/v1/projects/${ref}/config/database/pooler`, { allow404: true })) ?? [];
    return list.find((p) => p.database_type === 'PRIMARY' && p.pool_mode !== 'session') ?? list.find((p) => p.database_type === 'PRIMARY');
  }

  async health(ref: string, services: string[]): Promise<ServiceHealth[]> {
    return (await this.mgmt<ServiceHealth[]>('GET', `/v1/projects/${ref}/health?services=${services.join(',')}&timeout_ms=5000`)) ?? [];
  }

  private async send<T>(method: string, url: string, label: string, opts: CallOptions): Promise<T | null> {
    const signal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 30_000), ...(this.signal ? [this.signal] : [])]);
    const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.f(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal });
    } catch (err) {
      const name = (err as Error).name;
      if (this.signal?.aborted) throw new ProviderError('SUPABASE_CANCELLED', `${method} ${label} was cancelled.`, 'TIMEOUT', 'supabase');
      const timeout = name === 'TimeoutError' || name === 'AbortError';
      throw new ProviderError(
        timeout ? 'SUPABASE_TIMEOUT' : 'SUPABASE_UNREACHABLE',
        timeout ? `${method} ${label} timed out.` : `${method} ${label} failed: ${redact((err as Error).message ?? 'network error', 160)}`,
        timeout ? 'TIMEOUT' : 'NETWORK_ERROR',
        'supabase',
      );
    }
    const text = await res.text();
    if (opts.allow404 && isNotFound(res.status, text)) return null;
    if (!res.ok) {
      throw new ProviderError(
        'SUPABASE_API_ERROR',
        `Supabase returned HTTP ${res.status} for ${method} ${label}: ${redact(errorText(text), 240)}`,
        failureClassForStatus(res.status),
        'supabase',
        { status: res.status },
      );
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return { message: text } as T;
    }
  }
}
