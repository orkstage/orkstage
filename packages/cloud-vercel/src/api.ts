// SPDX-License-Identifier: AGPL-3.0-only
import { failureClassForStatus, ProviderError, redact, safeMessage } from '@orkstage/cloud-core';
import type { FailureClass } from '@orkstage/domain';
import { VERCEL_API } from './config.js';

/** Deployment lifecycle states reported by the REST API. */
export type ReadyState = 'QUEUED' | 'INITIALIZING' | 'BUILDING' | 'READY' | 'ERROR' | 'CANCELED' | 'BLOCKED' | 'DELETED';

/** Git connection of a project; fields depend on the Git provider. */
export interface ProjectLink {
  type: string;
  org?: string;
  repo?: string;
  repoId?: number | string;
  productionBranch?: string;
  projectId?: string | number;
  projectNamespace?: string;
  projectName?: string;
  owner?: string;
  slug?: string;
}

export interface ProductionTarget {
  id: string;
  url?: string;
  readyState?: ReadyState;
  alias?: string[];
  createdAt?: number;
}

export interface Project {
  id: string;
  name: string;
  framework?: string | null;
  buildCommand?: string | null;
  installCommand?: string | null;
  outputDirectory?: string | null;
  rootDirectory?: string | null;
  nodeVersion?: string;
  resourceConfig?: { functionDefaultRegions?: string[] };
  link?: ProjectLink;
  targets?: { production?: ProductionTarget | null };
}

export interface EnvVar {
  id: string;
  key: string;
  type: string;
  target?: string[] | string;
  gitBranch?: string | null;
  comment?: string;
}

export interface Deployment {
  uid: string;
  url?: string;
  readyState?: ReadyState;
  state?: ReadyState;
  target?: string | null;
  createdAt: number;
  ready?: number;
  errorMessage?: string;
  meta?: Record<string, string>;
}

export interface DeploymentEvent {
  type: string;
  created?: number;
  date?: number;
  text?: string;
  level?: 'error' | 'warning';
  payload?: { text?: string; date?: number; statusCode?: number };
}

interface CallOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  allow404?: boolean;
  timeoutMs?: number;
}

/**
 * Thin client for the Vercel REST API. Adds `teamId` to every call when the target names a team,
 * and scrubs the token and any registered secret value out of error messages.
 */
export class VercelApi {
  private readonly hidden = new Set<string>();

  constructor(
    private readonly token: string,
    private readonly teamId: string | undefined,
    private readonly fetchFn: typeof fetch,
    private readonly signal?: AbortSignal,
  ) {
    this.hide(token);
  }

  /** Registers a value that must never appear in an error message (an env var being written). */
  hide(value: string): void {
    if (value.length >= 4) this.hidden.add(value);
  }

  get<T>(path: string, opts: CallOptions = {}) {
    return this.call<T>('GET', path, opts);
  }
  post<T>(path: string, body: unknown, opts: CallOptions = {}) {
    return this.call<T>('POST', path, { ...opts, body });
  }
  patch<T>(path: string, body: unknown, opts: CallOptions = {}) {
    return this.call<T>('PATCH', path, { ...opts, body });
  }
  delete<T>(path: string, opts: CallOptions = {}) {
    return this.call<T>('DELETE', path, opts);
  }

  async call<T>(method: string, path: string, opts: CallOptions = {}): Promise<T | null> {
    const url = new URL(VERCEL_API + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    if (this.teamId) url.searchParams.set('teamId', this.teamId);
    const signal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 30_000), ...(this.signal ? [this.signal] : [])]);
    let res: Response;
    try {
      res = await this.fetchFn(url.toString(), {
        method,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal,
      });
    } catch (err) {
      const timeout = (err as Error).name === 'TimeoutError';
      throw new ProviderError(
        timeout ? 'VERCEL_TIMEOUT' : 'VERCEL_UNREACHABLE',
        `Vercel ${method} ${path} did not answer: ${this.scrub(safeMessage(err))}`,
        timeout ? 'TIMEOUT' : 'NETWORK_ERROR',
        'vercel',
      );
    }
    if (res.status === 404 && opts.allow404) return null;
    const text = await res.text();
    if (!res.ok) {
      let apiCode = '';
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
        apiCode = parsed.error?.code ?? '';
        message = parsed.error?.message ?? text;
      } catch {
        // Not JSON: keep the raw text, scrubbed below.
      }
      throw new ProviderError(
        'VERCEL_API_ERROR',
        `Vercel ${method} ${path} returned HTTP ${res.status}${apiCode ? ` (${apiCode})` : ''}: ${redact(this.scrub(message), 300)}`,
        failureClass(res.status),
        'vercel',
        { status: res.status, apiCode },
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private scrub(text: string): string {
    let out = text;
    for (const v of this.hidden) out = out.split(v).join('<redacted>');
    return out;
  }
}

function failureClass(status: number): FailureClass {
  return status === 402 ? 'QUOTA_EXCEEDED' : failureClassForStatus(status);
}

/** HTTP status of a Vercel API error, when the error came from the API. */
export function apiStatus(err: unknown): number | undefined {
  return err instanceof ProviderError && typeof err.details.status === 'number' ? err.details.status : undefined;
}

export const seg = (v: string) => encodeURIComponent(v);
