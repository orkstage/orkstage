// SPDX-License-Identifier: AGPL-3.0-only
import { failureClassForStatus, ProviderError, redact, safeMessage } from '@orkstage/cloud-core';
import { RENDER_API } from './config.js';

export type SuspendedState = 'suspended' | 'not_suspended';

export type DeployStatus =
  | 'created'
  | 'queued'
  | 'build_in_progress'
  | 'update_in_progress'
  | 'live'
  | 'deactivated'
  | 'build_failed'
  | 'update_failed'
  | 'canceled'
  | 'pre_deploy_in_progress'
  | 'pre_deploy_failed';

/** Datastore lifecycle states shared by Render Postgres and Key Value. */
export type DatastoreStatus =
  | 'creating'
  | 'available'
  | 'unavailable'
  | 'config_restart'
  | 'suspended'
  | 'maintenance_scheduled'
  | 'maintenance_in_progress'
  | 'recovery_failed'
  | 'recovery_in_progress'
  | 'unknown'
  | 'updating_instance';

export type ServiceType = 'static_site' | 'web_service' | 'private_service' | 'background_worker' | 'cron_job';

export interface Autoscaling {
  enabled: boolean;
  min: number;
  max: number;
  criteria: { cpu: { enabled: boolean; percentage: number }; memory: { enabled: boolean; percentage: number } };
}

/** The subset of `serviceDetails` this adapter reads (static sites and image services). */
export interface ServiceDetails {
  url?: string;
  buildCommand?: string;
  publishPath?: string;
  pullRequestPreviewsEnabled?: 'yes' | 'no';
  previews?: { generation?: 'off' | 'manual' | 'automatic' };
  plan?: string;
  region?: string;
  numInstances?: number;
  healthCheckPath?: string;
  autoscaling?: Autoscaling;
  runtime?: string;
}

export interface Service {
  id: string;
  name: string;
  ownerId: string;
  type: ServiceType;
  slug: string;
  repo?: string;
  branch?: string;
  rootDir?: string;
  imagePath?: string;
  dashboardUrl: string;
  suspended: SuspendedState;
  suspenders?: string[];
  serviceDetails: ServiceDetails;
}

export interface Deploy {
  id: string;
  status?: DeployStatus;
  trigger?: string;
  commit?: { id?: string; message?: string };
  image?: { ref?: string; sha?: string };
  createdAt?: string;
  finishedAt?: string;
}

export interface IpRule {
  cidrBlock: string;
  description: string;
}

export interface Postgres {
  id: string;
  name: string;
  owner?: { id: string; name: string };
  plan: string;
  region: string;
  version: string;
  status: DatastoreStatus;
  suspended: SuspendedState;
  suspenders?: string[];
  databaseName: string;
  databaseUser: string;
  diskSizeGB?: number;
  highAvailabilityEnabled: boolean;
  ipAllowList: IpRule[];
  dashboardUrl: string;
}

export interface KeyValue {
  id: string;
  name: string;
  owner?: { id: string; name: string };
  plan: string;
  region: string;
  status: DatastoreStatus;
  ipAllowList: IpRule[];
  dashboardUrl: string;
}

export interface EnvVar {
  key: string;
  value: string;
}

export interface CustomDomain {
  id: string;
  name: string;
  verificationStatus?: 'verified' | 'unverified';
  /** Set on the automatic www (or apex) entry that redirects to another domain. */
  redirectForName?: string;
}

export interface Owner {
  id: string;
  name: string;
  type: 'user' | 'team';
}

export interface LogEntry {
  id: string;
  message: string;
  timestamp: string;
  labels: { name: string; value: string }[];
}

type Query = Record<string, string | number | boolean | string[] | undefined>;

interface CallOptions {
  body?: unknown;
  query?: Query;
  /** Return null instead of failing when the resource does not exist. */
  allow404?: boolean;
  /** Leave the response body out of error messages (requests that carry secret values). */
  quiet?: boolean;
  /** Values removed from error messages (environment variable values sent in the request). */
  scrub?: string[];
  timeoutMs?: number;
}

/** Pulls the human readable part out of a Render error body (`{ id, message }`). */
function errorText(raw: string, scrub: string[] = []): string {
  let text = raw;
  for (const v of scrub) if (v.length >= 4) text = text.split(v).join('<redacted>');
  try {
    const j = JSON.parse(text) as { message?: unknown };
    if (typeof j.message === 'string') return redact(j.message);
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return redact(text);
}

function queryString(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) params.append(k, String(item));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * Thin client for the Render REST API (https://api.render.com/v1). Errors become
 * ProviderError with a failure class from the HTTP status and a redacted message.
 */
export class RenderApi {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly signal?: AbortSignal,
  ) {}

  async call<T>(method: string, path: string, opts: CallOptions = {}): Promise<T | null> {
    const url = `${RENDER_API}${path}${queryString(opts.query)}`;
    const signal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 30_000), ...(this.signal ? [this.signal] : [])]);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal,
      });
    } catch (err) {
      const timeout = (err as Error).name === 'TimeoutError';
      throw new ProviderError(timeout ? 'RENDER_TIMEOUT' : 'RENDER_UNREACHABLE', `Render API ${method} ${path} failed: ${safeMessage(err)}`, timeout ? 'TIMEOUT' : 'NETWORK_ERROR', 'render');
    }
    if (res.status === 404 && opts.allow404) return null;
    const text = await res.text();
    if (!res.ok) {
      const detail = opts.quiet ? '' : `: ${errorText(text, opts.scrub)}`;
      throw new ProviderError(`RENDER_HTTP_${res.status}`, `Render API ${method} ${path} returned HTTP ${res.status}${detail}`, failureClassForStatus(res.status), 'render', { status: res.status });
    }
    return (text ? JSON.parse(text) : null) as T | null;
  }

  /** Lists every page of a cursor paginated collection; rows look like `{ <key>: item, cursor }`. */
  async list<T>(path: string, key: string, query: Query = {}, maxPages = 20): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const rows = (await this.call<Record<string, unknown>[]>('GET', path, { query: { ...query, limit: 100, cursor } })) ?? [];
      for (const row of rows) out.push(row[key] as T);
      cursor = rows.length === 100 ? (rows[rows.length - 1]?.cursor as string | undefined) : undefined;
      if (!cursor) break;
    }
    return out;
  }
}
