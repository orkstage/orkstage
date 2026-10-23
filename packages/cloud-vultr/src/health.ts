// SPDX-License-Identifier: AGPL-3.0-only
import { csv, httpHealth, type HealthResult, type ResourceOutputs } from '@orkstage/cloud-core';
import { S3CompatibleStateStore, type S3CompatibleOptions } from '@orkstage/cloud-tofu';
import type { HealthState } from '@orkstage/domain';
import { statusOf, type VultrApi, type VultrDatabase, type VultrInstance, type VultrLoadBalancer, type VultrObjectStorage } from './api.js';
import { STATE_SIGNING_REGION } from './config.js';

/** HEAD on a bucket with the given keys; throws when it is missing or not accessible. */
export type HeadBucket = (opts: S3CompatibleOptions, signal?: AbortSignal) => Promise<void>;

export const headBucketS3: HeadBucket = (opts, signal) => new S3CompatibleStateStore(opts).check(signal);

export interface HealthDeps {
  fetch: typeof fetch;
  signal?: AbortSignal;
  headBucket: HeadBucket;
}

const result = (state: HealthState, message: string, started: number): HealthResult => ({
  state,
  message,
  latencyMs: Date.now() - started,
  checkedAt: new Date().toISOString(),
});

/** Maps a managed database status to a health state. */
export function databaseState(status: string): HealthState {
  const s = status.toLowerCase();
  if (s === 'running') return 'HEALTHY';
  if (['rebuilding', 'rebalancing', 'configuring'].includes(s)) return 'DEGRADED';
  return 'UNHEALTHY';
}

/**
 * Reads actual state from the Vultr API for one resource, using the ids recorded in its
 * OpenTofu outputs.
 */
export async function checkVultrHealth(api: VultrApi, kind: string, out: ResourceOutputs, deps: HealthDeps): Promise<HealthResult> {
  const started = Date.now();
  switch (kind) {
    case 'network': {
      await api.get(`/vpcs/${out.network_id}`);
      return result('HEALTHY', 'VPC available', started);
    }
    case 'compute.container-service': {
      const ids = csv(out.instance_ids);
      if (!ids.length) return result('DEGRADED', 'No instances (replicas is 0)', started);
      let ready = 0;
      for (const id of ids) {
        const r = await api.get<{ instance: VultrInstance }>(`/instances/${id}`);
        if (r?.instance.power_status === 'running' && r.instance.server_status === 'ok') ready++;
      }
      const state: HealthState = ready === ids.length ? 'HEALTHY' : ready > 0 ? 'DEGRADED' : 'UNHEALTHY';
      return result(state, `${ready}/${ids.length} instance(s) running`, started);
    }
    case 'database.postgresql':
    case 'cache.redis': {
      const r = await api.get<{ database: VultrDatabase }>(`/databases/${out.id}`);
      const status = r?.database.status ?? 'unknown';
      return result(databaseState(status), `Managed database ${status}`, started);
    }
    case 'object-storage': {
      const r = await api.get<{ object_storage: VultrObjectStorage }>(`/object-storage/${out.id}`);
      const sub = r?.object_storage;
      if (sub?.status !== 'active') return result('DEGRADED', `Object Storage subscription ${sub?.status ?? 'unknown'}`, started);
      try {
        await deps.headBucket(
          { endpoint: `https://${sub.s3_hostname}`, region: STATE_SIGNING_REGION, bucket: String(out.bucket), accessKeyId: sub.s3_access_key, secretAccessKey: sub.s3_secret_key, pathStyle: true },
          deps.signal,
        );
        return result('HEALTHY', 'Bucket reachable', started);
      } catch {
        return result('UNHEALTHY', `Bucket ${out.bucket} not reachable`, started);
      }
    }
    case 'ingress': {
      const r = await api.get<{ load_balancer: VultrLoadBalancer }>(`/load-balancers/${out.lb_id}`);
      const status = r?.load_balancer.status ?? 'unknown';
      if (status !== 'active') return result(status === 'pending' ? 'DEGRADED' : 'UNHEALTHY', `Load balancer ${status}`, started);
      if (!(r?.load_balancer.instances ?? []).length) return result('DEGRADED', 'Load balancer active, no attached instances yet', started);
      return httpHealth(String(out.url), { fetch: deps.fetch, signal: deps.signal });
    }
    default:
      return result('UNKNOWN', `No health check for ${kind}`, started);
  }
}

/** API path that identifies a resource, for existence probes. */
function probePath(kind: string, out: ResourceOutputs): string | undefined {
  switch (kind) {
    case 'network':
      return `/vpcs/${out.network_id}`;
    case 'compute.container-service': {
      const first = csv(out.instance_ids)[0];
      return first ? `/instances/${first}` : `/firewalls/${out.firewall_group_id}`;
    }
    case 'database.postgresql':
    case 'cache.redis':
      return `/databases/${out.id}`;
    case 'object-storage':
      return `/object-storage/${out.id}`;
    case 'ingress':
      return `/load-balancers/${out.lb_id}`;
    default:
      return undefined;
  }
}

/** `false` only when Vultr answers 404 for the resource; `undefined` when it cannot tell. */
export async function probeVultrExists(api: VultrApi, kind: string, out: ResourceOutputs): Promise<boolean | undefined> {
  const path = probePath(kind, out);
  if (!path) return undefined;
  try {
    return (await api.get(path, true)) !== null;
  } catch (err) {
    return statusOf(err) === 404 ? false : undefined;
  }
}
