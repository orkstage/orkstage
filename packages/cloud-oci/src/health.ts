import { csv, httpHealth, now, type HealthResult, type LogLine, type ResourceOutputs } from '@orkstage/cloud-core';
import type { HealthState } from '@orkstage/domain';
import type { OciClient } from './auth.js';
import { endpoints } from './config.js';

type Lifecycle = { lifecycleState?: string };

const READY = new Set(['ACTIVE', 'AVAILABLE']);
const BUSY = new Set(['CREATING', 'PROVISIONING', 'UPDATING', 'STARTING', 'INACTIVE']);
const GONE = new Set(['DELETED', 'TERMINATED']);

const stateOf = (lifecycle: string | undefined): HealthState =>
  lifecycle && READY.has(lifecycle) ? 'HEALTHY' : lifecycle && BUSY.has(lifecycle) ? 'DEGRADED' : 'UNHEALTHY';

const result = (state: HealthState, message: string, started: number): HealthResult => ({ state, message, latencyMs: Date.now() - started, checkedAt: now() });

/** The REST URL of the resource a module created, from its outputs. */
export function resourceUrl(kind: string, out: ResourceOutputs, region: string): string | undefined {
  const api = endpoints(region);
  switch (kind) {
    case 'network':
      return out.network_id ? `${api.core}/vcns/${out.network_id}` : undefined;
    case 'compute.container-service':
      return out.service_id ? `${api.containers}/containerInstances/${out.service_id}` : undefined;
    case 'database.postgresql':
      return out.id ? `${api.postgres}/dbSystems/${out.id}` : undefined;
    case 'cache.redis':
      return out.id ? `${api.cache}/redisClusters/${out.id}` : undefined;
    case 'object-storage':
      return out.bucket && out.namespace ? `${api.objectStorage}/n/${out.namespace}/b/${out.bucket}` : undefined;
    case 'ingress':
      return out.load_balancer_id ? `${api.loadBalancer}/loadBalancers/${out.load_balancer_id}` : undefined;
    default:
      return undefined;
  }
}

/** Reads the actual state of one resource through the OCI REST APIs. */
export async function checkOciHealth(
  client: OciClient,
  kind: string,
  out: ResourceOutputs,
  region: string,
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<HealthResult> {
  const started = Date.now();
  const signal = opts.signal;
  if (kind === 'compute.container-service') {
    const ids = csv(out.instance_ids);
    if (!ids.length) return result('UNHEALTHY', 'No container instances (replicas is 0).', started);
    const states = await Promise.all(
      ids.map(async (id) => (await client.json<Lifecycle>('GET', `${endpoints(region).containers}/containerInstances/${id}`, { signal, allow404: true }))?.lifecycleState ?? 'DELETED'),
    );
    const active = states.filter((s) => s === 'ACTIVE').length;
    const state: HealthState = active === ids.length ? 'HEALTHY' : active > 0 || states.some((s) => BUSY.has(s)) ? 'DEGRADED' : 'UNHEALTHY';
    return result(state, `${active}/${ids.length} container instance(s) active`, started);
  }
  const url = resourceUrl(kind, out, region);
  if (!url) return result('UNKNOWN', `No health check for ${kind}`, started);
  if (kind === 'object-storage') {
    await client.json('GET', url, { signal });
    return result('HEALTHY', 'Bucket reachable', started);
  }
  const res = await client.json<Lifecycle>('GET', url, { signal });
  const lifecycle = res?.lifecycleState ?? 'UNKNOWN';
  const state = stateOf(lifecycle);
  if (kind === 'ingress' && state === 'HEALTHY' && out.url) return httpHealth(String(out.url), { fetch: opts.fetch, signal });
  return result(state, `${label(kind)} ${lifecycle}`, started);
}

function label(kind: string): string {
  return { network: 'VCN', 'database.postgresql': 'PostgreSQL', 'cache.redis': 'Cache cluster', ingress: 'Load balancer' }[kind] ?? kind;
}

/**
 * Live existence check: `false` only when OCI answers 404 or reports the resource deleted;
 * `undefined` when it cannot tell.
 */
export async function probeOciExists(client: OciClient, kind: string, out: ResourceOutputs, region: string, signal?: AbortSignal): Promise<boolean | undefined> {
  const url = resourceUrl(kind, out, region);
  if (!url) return undefined;
  try {
    const res = await client.json<Lifecycle>('GET', url, { signal, allow404: true });
    if (!res) return false;
    return !GONE.has(res.lifecycleState ?? '');
  } catch {
    return undefined;
  }
}

/** Recent output of the containers of a service, replica by replica, up to `limit` lines. */
export async function readContainerLogs(client: OciClient, out: ResourceOutputs, region: string, limit: number, signal?: AbortSignal): Promise<LogLine[]> {
  const api = endpoints(region);
  const lines: LogLine[] = [];
  for (const [replica, id] of csv(out.instance_ids).entries()) {
    const ci = await client.json<{ containers?: { containerId: string }[] }>('GET', `${api.containers}/containerInstances/${id}`, { signal, allow404: true });
    for (const c of ci?.containers ?? []) {
      const res = await client.request('POST', `${api.containers}/containers/${c.containerId}/actions/retrieveLogs`, { signal });
      if (!res.ok) continue;
      const text = await res.text();
      const timestamp = now();
      for (const message of text.split('\n').filter(Boolean).slice(-limit)) {
        lines.push({ timestamp, level: /error|exception|fatal/i.test(message) ? 'error' : 'info', message: message.slice(0, 2000), attributes: { replica: String(replica) } });
      }
      if (lines.length >= limit) return lines.slice(-limit);
    }
  }
  return lines;
}
