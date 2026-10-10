import { csv, httpHealth, now, requestJson, type HealthResult, type LogLine, type ResourceOutputs } from '@orkstage/cloud-core';
import { S3CompatibleStateStore } from '@orkstage/cloud-tofu';
import type { HealthState } from '@orkstage/domain';
import { apiBase, objectStorageEndpoint, type MagaluCredentials } from './config.js';

export interface MagaluApi {
  region: string;
  apiKey: string;
  fetch: typeof fetch;
  signal?: AbortSignal;
}

/** GET on the regional Magalu REST API; `null` when the resource is gone (404). */
export function apiGet<T>(api: MagaluApi, path: string): Promise<T | null> {
  return requestJson<T>(`${apiBase(api.region)}${path}`, {
    headers: { 'X-API-Key': api.apiKey, accept: 'application/json' },
    fetch: api.fetch,
    signal: api.signal,
    allow404: true,
  });
}

export function apiPost(api: MagaluApi, path: string): Promise<unknown> {
  return requestJson(`${apiBase(api.region)}${path}`, {
    method: 'POST',
    headers: { 'X-API-Key': api.apiKey, accept: 'application/json' },
    fetch: api.fetch,
    signal: api.signal,
  });
}

const result = (state: HealthState, message: string, started: number): HealthResult => ({ state, message, latencyMs: Date.now() - started, checkedAt: now() });

const vmPath = (id: string) => `/compute/v1/instances/${encodeURIComponent(id)}`;
const dbPath = (out: ResourceOutputs) => `/database/v2/${out.deployment === 'cluster' ? 'clusters' : 'instances'}/${encodeURIComponent(String(out.instance_id))}`;

const DB_BUSY = ['BACKING_UP', 'MAINTENANCE', 'RESIZING', 'REBOOT', 'STARTING', 'RESTORING', 'CREATING', 'PENDING'];

function bucketStore(out: ResourceOutputs, creds: MagaluCredentials, region: string) {
  return new S3CompatibleStateStore({
    endpoint: objectStorageEndpoint(String(out.region ?? region)),
    region: String(out.region ?? region),
    bucket: String(out.bucket),
    accessKeyId: creds.stateAccessKeyId,
    secretAccessKey: creds.stateSecretAccessKey,
  });
}

/** Actual state of one resource from the Magalu REST API, using the ids in its outputs. */
export async function checkMagaluHealth(kind: string, out: ResourceOutputs, api: MagaluApi, creds: MagaluCredentials): Promise<HealthResult> {
  const started = Date.now();
  switch (kind) {
    case 'network': {
      const vpc = await apiGet<{ status?: string }>(api, `/network/v0/vpcs/${encodeURIComponent(String(out.vpc_id))}`);
      if (!vpc) return result('UNHEALTHY', 'VPC not found', started);
      const status = vpc.status ?? 'unknown';
      const state: HealthState = /error|fail/i.test(status) ? 'UNHEALTHY' : /pend|creat|process/i.test(status) ? 'DEGRADED' : 'HEALTHY';
      return result(state, `VPC ${status}`, started);
    }
    case 'compute.container-service': {
      const ids = csv(out.instance_ids);
      if (!ids.length) return result('DEGRADED', 'No virtual machines (0 replicas)', started);
      let running = 0;
      for (const id of ids) {
        const vm = await apiGet<{ state?: string }>(api, vmPath(id));
        if (vm?.state === 'running') running++;
      }
      if (running < ids.length) return result(running > 0 ? 'DEGRADED' : 'UNHEALTHY', `${running}/${ids.length} VM(s) running`, started);
      // Only public URLs are reachable from the control plane.
      const url = String(out.url ?? '');
      const privateHosts = csv(out.private_ips);
      if (url && !privateHosts.some((h) => url.includes(`//${h}:`))) {
        const http = await httpHealth(url, { fetch: api.fetch, signal: api.signal });
        return { ...http, message: `${running}/${ids.length} VM(s) running; ${http.message ?? ''}`.trim() };
      }
      return result('HEALTHY', `${running}/${ids.length} VM(s) running`, started);
    }
    case 'database.postgresql': {
      const db = await apiGet<{ status?: string }>(api, dbPath(out));
      if (!db) return result('UNHEALTHY', 'DBaaS instance not found', started);
      const status = String(db.status ?? 'UNKNOWN').toUpperCase();
      return result(status === 'ACTIVE' ? 'HEALTHY' : DB_BUSY.includes(status) ? 'DEGRADED' : 'UNHEALTHY', `DBaaS ${status}`, started);
    }
    case 'object-storage': {
      await bucketStore(out, creds, api.region).check(api.signal);
      return result('HEALTHY', 'Bucket reachable', started);
    }
    default:
      return result('UNKNOWN', `No health check for ${kind}`, started);
  }
}

/** Live existence check: `false` only when the API answers 404, `undefined` when it cannot tell. */
export async function probeMagaluExists(kind: string, out: ResourceOutputs, api: MagaluApi, creds: MagaluCredentials): Promise<boolean | undefined> {
  try {
    switch (kind) {
      case 'network':
        return (await apiGet(api, `/network/v0/vpcs/${encodeURIComponent(String(out.vpc_id))}`)) !== null;
      case 'compute.container-service': {
        for (const id of csv(out.instance_ids)) {
          if ((await apiGet(api, vmPath(id))) === null) return false;
        }
        return true;
      }
      case 'database.postgresql':
        return (await apiGet(api, dbPath(out))) !== null;
      case 'object-storage':
        await bucketStore(out, creds, api.region).check(api.signal);
        return true;
      default:
        return undefined;
    }
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    return e.name === 'NotFound' || e.name === 'NoSuchBucket' || e.$metadata?.httpStatusCode === 404 ? false : undefined;
  }
}

/** Boot (cloud-init) log lines of the service VMs, which include the Docker install and start. */
export async function readInitLogs(out: ResourceOutputs, api: MagaluApi, limit: number): Promise<LogLine[]> {
  const lines: LogLine[] = [];
  for (const id of csv(out.instance_ids)) {
    const r = await apiGet<{ logs?: string[] }>(api, `${vmPath(id)}/init-logs`);
    for (const message of (r?.logs ?? []).slice(-limit)) {
      lines.push({ timestamp: now(), level: /error|fail/i.test(message) ? 'error' : 'info', message: message.slice(0, 2000), attributes: { instance: id } });
    }
  }
  return lines.slice(-limit);
}
