// SPDX-License-Identifier: AGPL-3.0-only
import {
  HttpError,
  httpHealth,
  requestJson,
  type HealthResult,
  type LogLine,
  type ProviderDeployment,
  type ResourceOutputs,
} from '@orkstage/cloud-core';
import { S3CompatibleStateStore } from '@orkstage/cloud-tofu';
import type { HealthState } from '@orkstage/domain';
import { SPACES_SIGNING_REGION, spacesEndpoint, type DigitalOceanCredentials } from './config.js';

export const API = 'https://api.digitalocean.com';

/** Calls the DigitalOcean API with the target token. `allow404` turns a 404 into `null`. */
export interface DoApi {
  <T>(path: string, init?: { method?: string; body?: unknown; allow404?: boolean }): Promise<T | null>;
}

export function doApi(token: string, fetchImpl: typeof fetch, signal?: AbortSignal): DoApi {
  return <T>(path: string, init: { method?: string; body?: unknown; allow404?: boolean } = {}) =>
    requestJson<T>(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      allow404: init.allow404,
      fetch: fetchImpl,
      signal,
    });
}

export interface AppDeployment {
  id: string;
  phase?: string;
  cause?: string;
  created_at?: string;
  updated_at?: string;
  phase_last_updated_at?: string;
  spec?: { services?: { image?: { repository?: string; tag?: string; digest?: string } }[] };
}

interface App {
  id: string;
  live_url?: string;
  default_ingress?: string;
  active_deployment?: AppDeployment;
  in_progress_deployment?: AppDeployment;
  pending_deployment?: AppDeployment;
}

interface Database {
  id: string;
  name?: string;
  status?: string;
  connection?: { uri?: string; host?: string; port?: number; user?: string; password?: string; database?: string };
}

const result = (state: HealthState, message: string, started: number): HealthResult => ({
  state,
  message,
  latencyMs: Date.now() - started,
  checkedAt: new Date().toISOString(),
});

const DB_TRANSITIONS = new Set(['creating', 'resizing', 'migrating', 'forking', 'restoring']);

/** Spaces bucket reachability through the same S3 client the state store uses. */
export function spacesBucket(creds: DigitalOceanCredentials, bucket: string, region: string): S3CompatibleStateStore {
  return new S3CompatibleStateStore({
    endpoint: spacesEndpoint(region),
    region: SPACES_SIGNING_REGION,
    bucket,
    accessKeyId: creds.spacesAccessKeyId,
    secretAccessKey: creds.spacesSecretAccessKey,
    pathStyle: true,
  });
}

/**
 * Actual state of one resource from the DigitalOcean API, using the ids in its outputs. App
 * Platform services also get an HTTP check on their public URL.
 */
export async function checkDigitalOceanHealth(
  kind: string,
  out: ResourceOutputs,
  ctx: { api: DoApi; creds: DigitalOceanCredentials; fetch: typeof fetch; signal?: AbortSignal; healthPath?: string },
): Promise<HealthResult> {
  const started = Date.now();
  switch (kind) {
    case 'network': {
      const r = await ctx.api<{ vpc: { id: string } }>(`/v2/vpcs/${encodeURIComponent(String(out.network_id))}`, { allow404: true });
      return r ? result('HEALTHY', 'VPC available', started) : result('UNHEALTHY', 'VPC not found', started);
    }
    case 'compute.container-service': {
      const r = await ctx.api<{ app: App }>(`/v2/apps/${encodeURIComponent(String(out.service_id))}`, { allow404: true });
      if (!r) return result('UNHEALTHY', 'App not found', started);
      const app = r.app;
      const active = app.active_deployment?.phase === 'ACTIVE';
      const rolling = Boolean(app.in_progress_deployment ?? app.pending_deployment);
      if (!active) return result(rolling ? 'DEGRADED' : 'UNHEALTHY', rolling ? 'First deployment in progress' : 'No active deployment', started);
      // An empty url output means an internal service: there is nothing public to probe.
      const url = out.url === undefined ? app.live_url : String(out.url);
      if (!url) return result(rolling ? 'DEGRADED' : 'HEALTHY', rolling ? 'Active, new deployment in progress' : 'Active deployment (internal service)', started);
      const http = await httpHealth(new URL(ctx.healthPath ?? '/', url).toString(), { fetch: ctx.fetch, signal: ctx.signal });
      if (http.state === 'HEALTHY' && rolling) return { ...http, state: 'DEGRADED', message: `${http.message}; new deployment in progress` };
      return http;
    }
    case 'database.postgresql':
    case 'cache.redis': {
      const r = await ctx.api<{ database: Database }>(`/v2/databases/${encodeURIComponent(String(out.cluster_id))}`, { allow404: true });
      if (!r) return result('UNHEALTHY', 'Database cluster not found', started);
      const status = r.database.status ?? 'unknown';
      return result(status === 'online' ? 'HEALTHY' : DB_TRANSITIONS.has(status) ? 'DEGRADED' : 'UNHEALTHY', `Cluster ${status}`, started);
    }
    case 'object-storage': {
      await spacesBucket(ctx.creds, String(out.bucket), String(out.region)).check(ctx.signal);
      return result('HEALTHY', 'Bucket reachable', started);
    }
    case 'ingress':
      return result('HEALTHY', 'App Platform routing; each service reports its own URL health', started);
    default:
      return result('UNKNOWN', `No health check for ${kind}`, started);
  }
}

/** Live existence check: `false` only on a 404 from the API (or S3 for Spaces). */
export async function probeDigitalOceanExists(kind: string, out: ResourceOutputs, ctx: { api: DoApi; creds: DigitalOceanCredentials; signal?: AbortSignal }): Promise<boolean | undefined> {
  const path =
    kind === 'network' ? `/v2/vpcs/${out.network_id}`
    : kind === 'compute.container-service' ? `/v2/apps/${out.service_id}`
    : kind === 'database.postgresql' || kind === 'cache.redis' ? `/v2/databases/${out.cluster_id}`
    : undefined;
  try {
    if (path) return (await ctx.api(path, { allow404: true })) !== null;
    if (kind === 'object-storage') {
      await spacesBucket(ctx.creds, String(out.bucket), String(out.region)).check(ctx.signal);
      return true;
    }
    return undefined;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === 'NotFound' || e.name === 'NoSuchBucket' || e.$metadata?.httpStatusCode === 404) return false;
    return undefined;
  }
}

/** Connection fields of a managed database, for `do-db://<cluster id>` references. */
export async function readDatabaseConnection(api: DoApi, clusterId: string): Promise<Record<string, string>> {
  const r = await api<{ database: Database }>(`/v2/databases/${encodeURIComponent(clusterId)}`);
  const c = r?.database.connection ?? {};
  const fields: Record<string, string> = {
    url: c.uri ?? '',
    host: c.host ?? '',
    port: c.port === undefined ? '' : String(c.port),
    username: c.user ?? '',
    password: c.password ?? '',
    database: c.database ?? '',
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== ''));
}

const PHASES: Record<string, ProviderDeployment['status']> = {
  PENDING_BUILD: 'queued',
  BUILDING: 'building',
  PENDING_DEPLOY: 'deploying',
  DEPLOYING: 'deploying',
  ACTIVE: 'live',
  SUPERSEDED: 'superseded',
  ERROR: 'failed',
  CANCELED: 'cancelled',
};

export function toProviderDeployment(d: AppDeployment, liveUrl?: string): ProviderDeployment {
  const status = PHASES[d.phase ?? ''] ?? 'queued';
  const image = d.spec?.services?.[0]?.image;
  const terminal = ['live', 'failed', 'cancelled', 'superseded'].includes(status);
  return {
    id: d.id,
    status,
    createdAt: d.created_at ?? new Date(0).toISOString(),
    ...(terminal && (d.phase_last_updated_at ?? d.updated_at) ? { finishedAt: d.phase_last_updated_at ?? d.updated_at } : {}),
    ...(status === 'live' && liveUrl ? { url: liveUrl } : {}),
    ...(image ? { revision: image.digest || image.tag } : {}),
    ...(d.cause ? { message: d.cause.slice(0, 200) } : {}),
  };
}

export async function listAppDeployments(api: DoApi, appId: string, limit: number, liveUrl?: string): Promise<ProviderDeployment[]> {
  const r = await api<{ deployments?: AppDeployment[] }>(`/v2/apps/${encodeURIComponent(appId)}/deployments?page=1&per_page=${Math.min(Math.max(limit, 1), 100)}`);
  return (r?.deployments ?? []).slice(0, limit).map((d) => toProviderDeployment(d, liveUrl));
}

/**
 * Recent run logs of the app's component. The API answers with links to the log text (a live
 * link and archived ones); the text has one `<component> <timestamp> <message>` line per entry.
 */
export async function readAppLogs(api: DoApi, out: ResourceOutputs, limit: number, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<LogLine[]> {
  const component = encodeURIComponent(String(out.component ?? 'service'));
  let links: { live_url?: string; url?: string; historic_urls?: string[]; historic_logs?: string[] } | null;
  try {
    links = await api(`/v2/apps/${encodeURIComponent(String(out.service_id))}/components/${component}/logs?type=RUN&follow=false&tail_lines=${limit}&pod_connection_timeout=10s`, { allow404: true });
  } catch (err) {
    // No running instance yet (first deployment) is not an error for the log view.
    if (err instanceof HttpError && err.status === 400) return [];
    throw err;
  }
  const url = links?.historic_urls?.[0] ?? links?.historic_logs?.[0] ?? links?.live_url ?? links?.url;
  if (!url) return [];
  const res = await fetchImpl(url, { signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) });
  if (!res.ok) return [];
  const lines = (await res.text()).split('\n').filter((l) => l.trim().length > 0).slice(-limit);
  return lines.map(parseLogLine);
}

const LINE = /^(\S+)\s+(\d{4}-\d{2}-\d{2}T\S+)\s?(.*)$/;

export function parseLogLine(line: string): LogLine {
  const m = LINE.exec(line);
  const message = (m ? m[3]! : line).slice(0, 2000);
  const timestamp = m && !Number.isNaN(Date.parse(m[2]!)) ? new Date(m[2]!).toISOString() : new Date().toISOString();
  return { timestamp, level: /\b(error|exception|fatal|panic)\b/i.test(message) ? 'error' : /\bwarn(ing)?\b/i.test(message) ? 'warn' : 'info', message };
}
