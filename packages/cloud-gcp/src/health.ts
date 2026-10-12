// SPDX-License-Identifier: AGPL-3.0-only
import { HttpError, httpHealth, ProviderError, type HealthResult, type LogLine, type ResourceOutputs } from '@orkstage/cloud-core';
import type { HealthState } from '@orkstage/domain';
import type { GcpApi } from './auth.js';
import { SECRET_NAME } from './stacks.js';

const result = (state: HealthState, message: string, started: number): HealthResult => ({
  state,
  message,
  latencyMs: Date.now() - started,
  checkedAt: new Date().toISOString(),
});

/** REST URL that describes the resource, from the identifiers in its module outputs. */
export function resourceUrl(kind: string, out: ResourceOutputs, projectId: string): string | undefined {
  switch (kind) {
    case 'network':
      return out.network_id ? `https://compute.googleapis.com/compute/v1/${String(out.network_id)}` : undefined;
    case 'compute.container-service':
      return out.service_id ? `https://run.googleapis.com/v2/${String(out.service_id)}` : undefined;
    case 'database.postgresql':
      return out.instance_name ? `https://sqladmin.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/instances/${encodeURIComponent(String(out.instance_name))}` : undefined;
    case 'cache.redis':
      return out.instance_id ? `https://redis.googleapis.com/v1/${String(out.instance_id)}` : undefined;
    case 'object-storage':
      return out.bucket ? `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(String(out.bucket))}?fields=name` : undefined;
    default:
      return undefined;
  }
}

type Condition = { type?: string; state?: string; message?: string };

/**
 * Reads actual state from Google Cloud APIs for one resource: Cloud Run terminal condition (plus
 * an HTTP check of the public URL), Cloud SQL and Memorystore instance state, network and bucket
 * existence.
 */
export async function gcpHealth(
  api: GcpApi,
  kind: string,
  out: ResourceOutputs,
  projectId: string,
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<HealthResult> {
  const started = Date.now();
  if (kind === 'ingress') return result('HEALTHY', 'Built in Cloud Run HTTPS endpoints', started);
  const url = resourceUrl(kind, out, projectId);
  if (!url) return result('UNKNOWN', `No health check for ${kind}`, started);
  const body = await api<Record<string, unknown>>(url, { allow404: true });
  if (!body) return result('UNHEALTHY', 'Not found in Google Cloud', started);

  switch (kind) {
    case 'compute.container-service': {
      const cond = (body.terminalCondition ?? {}) as Condition;
      const state = cond.state ?? 'CONDITION_PENDING';
      if (state === 'CONDITION_FAILED') return result('UNHEALTHY', `Cloud Run not ready: ${(cond.message ?? 'failed').slice(0, 200)}`, started);
      if (state !== 'CONDITION_SUCCEEDED') return result('DEGRADED', `Cloud Run ${state.replace('CONDITION_', '').toLowerCase()}`, started);
      if (out.url) {
        const http = await httpHealth(String(out.url), { fetch: opts.fetch, signal: opts.signal });
        return { ...http, message: `Ready; ${http.message ?? ''}`.trim() };
      }
      return result('HEALTHY', 'Cloud Run ready', started);
    }
    case 'database.postgresql': {
      const state = String(body.state ?? 'UNKNOWN');
      const health: HealthState = state === 'RUNNABLE' ? 'HEALTHY' : ['MAINTENANCE', 'PENDING_CREATE', 'ONLINE_MAINTENANCE'].includes(state) ? 'DEGRADED' : 'UNHEALTHY';
      return result(health, `Cloud SQL ${state}`, started);
    }
    case 'cache.redis': {
      const state = String(body.state ?? 'UNKNOWN');
      const health: HealthState = state === 'READY' ? 'HEALTHY' : ['CREATING', 'UPDATING', 'MAINTENANCE', 'IMPORTING', 'FAILING_OVER'].includes(state) ? 'DEGRADED' : 'UNHEALTHY';
      return result(health, `Memorystore ${state}`, started);
    }
    case 'network':
      return result('HEALTHY', 'VPC network present', started);
    case 'object-storage':
      return result('HEALTHY', 'Bucket reachable', started);
    default:
      return result('UNKNOWN', `No health check for ${kind}`, started);
  }
}

/** Live existence: `false` only on a 404 from the provider API, `undefined` when it cannot tell. */
export async function gcpProbe(api: GcpApi, kind: string, out: ResourceOutputs, projectId: string): Promise<boolean | undefined> {
  const url = resourceUrl(kind, out, projectId);
  if (!url) return undefined;
  try {
    return (await api(url, { allow404: true })) !== null;
  } catch {
    return undefined;
  }
}

type LogEntry = { timestamp?: string; severity?: string; textPayload?: string; jsonPayload?: Record<string, unknown>; httpRequest?: { requestMethod?: string; requestUrl?: string; status?: number } };

/** Recent Cloud Run log entries for one service from Cloud Logging, newest first. */
export async function cloudRunLogs(api: GcpApi, projectId: string, out: ResourceOutputs, limit: number): Promise<LogLine[]> {
  if (!out.service_name) return [];
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const r = await api<{ entries?: LogEntry[] }>('https://logging.googleapis.com/v2/entries:list', {
    method: 'POST',
    body: JSON.stringify({
      resourceNames: [`projects/${projectId}`],
      filter: `resource.type="cloud_run_revision" AND resource.labels.service_name="${String(out.service_name)}" AND timestamp>="${since}"`,
      orderBy: 'timestamp desc',
      pageSize: Math.min(Math.max(1, limit), 1000),
    }),
  });
  return (r?.entries ?? []).map((e) => {
    const sev = e.severity ?? 'DEFAULT';
    const level: LogLine['level'] = /ERROR|CRITICAL|ALERT|EMERGENCY/.test(sev) ? 'error' : sev === 'WARNING' ? 'warn' : sev === 'DEBUG' ? 'debug' : 'info';
    const message =
      e.textPayload ??
      (typeof e.jsonPayload?.message === 'string' ? e.jsonPayload.message : undefined) ??
      (e.httpRequest ? `${e.httpRequest.requestMethod ?? ''} ${e.httpRequest.requestUrl ?? ''} ${e.httpRequest.status ?? ''}`.trim() : JSON.stringify(e.jsonPayload ?? {}));
    return { timestamp: e.timestamp ?? new Date().toISOString(), level, message: message.slice(0, 2000) };
  });
}

/** Latest version of a Secret Manager secret published as `secret_ref`, as named string fields. */
export async function accessSecret(api: GcpApi, ref: string): Promise<Record<string, string>> {
  if (!SECRET_NAME.test(ref)) {
    throw new ProviderError('GCP_SECRET_REF_INVALID', 'Secret reference must look like projects/<project>/secrets/<name>.', 'VALIDATION_ERROR', 'gcp');
  }
  let r: { payload?: { data?: string } } | null;
  try {
    r = await api<{ payload?: { data?: string } }>(`https://secretmanager.googleapis.com/v1/${ref}/versions/latest:access`);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 0;
    throw new ProviderError('GCP_SECRET_UNREADABLE', `Secret ${ref.split('/').pop()} could not be read (HTTP ${status}).`, status === 403 ? 'AUTHORIZATION_ERROR' : status === 404 ? 'VALIDATION_ERROR' : 'NETWORK_ERROR', 'gcp');
  }
  const text = Buffer.from(r?.payload?.data ?? '', 'base64').toString('utf8');
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]));
  } catch {
    return { value: text };
  }
}

/**
 * Starts a new Cloud Run revision from the current template (same image and settings), which
 * replaces every running instance. Returns the long running operation name.
 */
export async function redeployCloudRun(api: GcpApi, serviceId: string): Promise<string | undefined> {
  const url = `https://run.googleapis.com/v2/${serviceId}`;
  const service = await api<Record<string, unknown>>(url);
  const op = await api<{ name?: string }>(`${url}?forceNewRevision=true`, { method: 'PATCH', body: JSON.stringify(service) });
  return op?.name;
}
