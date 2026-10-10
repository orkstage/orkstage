import { HttpError, httpHealth, now, safeMessage, type HealthResult, type LogLine, type ResourceOutputs } from '@orkstage/cloud-core';
import type { StateStore } from '@orkstage/cloud-tofu';
import type { HealthState } from '@orkstage/domain';
import type { CoreWeaveApi } from './api.js';
import { kubeRequest, kubeText, type ClusterAccess } from './kube.js';

const result = (state: HealthState, message: string, started: number): HealthResult => ({ state, message, latencyMs: Date.now() - started, checkedAt: now() });

const seg = (v: unknown) => encodeURIComponent(String(v));

export interface HealthDeps {
  fetch: typeof fetch;
  api: CoreWeaveApi;
  /** Kubernetes API access; resolved lazily because only cluster workloads need it. */
  cluster: () => Promise<ClusterAccess>;
  /** S3 access to a bucket with the target's AI Object Storage keys. */
  bucket: (name: string) => StateStore;
  signal?: AbortSignal;
}

type Deployment = { spec?: { replicas?: number }; status?: { replicas?: number; availableReplicas?: number; updatedReplicas?: number } };

/** Reads the live state of one resource through the CoreWeave, Kubernetes or S3 API. */
export async function coreweaveHealth(kind: string, out: ResourceOutputs, deps: HealthDeps): Promise<HealthResult> {
  const started = Date.now();
  switch (kind) {
    case 'network': {
      const vpc = await deps.api<{ vpc?: { name?: string } }>(`/v1beta1/networking/vpcs/${seg(out.network_id)}`, { allow404: true });
      return vpc ? result('HEALTHY', `VPC ${vpc.vpc?.name ?? out.vpc_name ?? out.network_id} present`, started) : result('UNHEALTHY', 'VPC not found', started);
    }
    case 'compute.container-service': {
      try {
        const access = await deps.cluster();
        const d = await kubeRequest<Deployment>(deps.fetch, access, `/apis/apps/v1/namespaces/${seg(out.namespace)}/deployments/${seg(out.deployment)}`, { allow404: true, signal: deps.signal });
        if (!d) return result('UNHEALTHY', 'Deployment not found', started);
        const desired = d.spec?.replicas ?? 0;
        const available = d.status?.availableReplicas ?? 0;
        if (desired === 0) return result('HEALTHY', 'Scaled to zero replicas', started);
        const state: HealthState = available >= desired ? 'HEALTHY' : available > 0 ? 'DEGRADED' : 'UNHEALTHY';
        return result(state, `${available}/${desired} replica(s) available`, started);
      } catch (err) {
        if (err instanceof HttpError) return result(err.status === 401 || err.status === 403 ? 'UNKNOWN' : 'UNHEALTHY', `Kubernetes API: ${err.message}`, started);
        // The Kubernetes API is unreachable from here (private endpoint or a CA Node does not trust): use the public URL.
        if (out.url) {
          const h = await httpHealth(String(out.url), { fetch: deps.fetch, signal: deps.signal });
          return { ...h, message: `${h.message} (Kubernetes API unreachable: ${safeMessage(err)})` };
        }
        return result('UNKNOWN', `Kubernetes API unreachable: ${safeMessage(err)}`, started);
      }
    }
    case 'object-storage': {
      await deps.bucket(String(out.bucket)).check(deps.signal);
      return result('HEALTHY', 'Bucket reachable', started);
    }
    case 'ingress': {
      if (!out.url) return result('UNKNOWN', 'Ingress has no URL', started);
      return httpHealth(String(out.url), { fetch: deps.fetch, signal: deps.signal });
    }
    default:
      return result('UNKNOWN', `No health check for ${kind}`, started);
  }
}

/** True when an error means "not found" (CoreWeave API, Kubernetes API or S3). */
export function isNotFound(err: unknown): boolean {
  const e = err as { status?: number; name?: string; $metadata?: { httpStatusCode?: number } };
  return e.status === 404 || e.$metadata?.httpStatusCode === 404 || /NotFound|NoSuchBucket/i.test(e.name ?? '');
}

/** Live existence check: `false` only when the API answers 404 for the resource. */
export async function coreweaveProbe(kind: string, out: ResourceOutputs, deps: HealthDeps): Promise<boolean | undefined> {
  try {
    switch (kind) {
      case 'network':
        return (await deps.api(`/v1beta1/networking/vpcs/${seg(out.network_id)}`, { allow404: true })) !== null;
      case 'compute.container-service': {
        const path = `/apis/apps/v1/namespaces/${seg(out.namespace)}/deployments/${seg(out.deployment)}`;
        return (await kubeRequest(deps.fetch, await deps.cluster(), path, { allow404: true, signal: deps.signal })) !== null;
      }
      case 'ingress':
        return (await kubeRequest(deps.fetch, await deps.cluster(), `/api/v1/namespaces/${seg(out.namespace)}`, { allow404: true, signal: deps.signal })) !== null;
      case 'object-storage':
        await deps.bucket(String(out.bucket)).check(deps.signal);
        return true;
      default:
        return undefined;
    }
  } catch (err) {
    return isNotFound(err) ? false : undefined;
  }
}

type PodList = { items?: { metadata?: { name?: string } }[] };

/** Recent log lines of the service's pods (at most three pods), newest last. */
export async function podLogs(f: typeof fetch, access: ClusterAccess, out: ResourceOutputs, limit: number, signal?: AbortSignal): Promise<LogLine[]> {
  const ns = seg(out.namespace);
  const selector = encodeURIComponent(`app.kubernetes.io/name=${out.deployment}`);
  const pods = await kubeRequest<PodList>(f, access, `/api/v1/namespaces/${ns}/pods?labelSelector=${selector}&limit=3`, { signal });
  const lines: LogLine[] = [];
  for (const pod of (pods?.items ?? []).slice(0, 3)) {
    const name = pod.metadata?.name;
    if (!name) continue;
    const text = await kubeText(f, access, `/api/v1/namespaces/${ns}/pods/${seg(name)}/log?tailLines=${limit}&timestamps=true`, signal);
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      const space = raw.indexOf(' ');
      const ts = space > 0 ? raw.slice(0, space) : '';
      const valid = ts && !Number.isNaN(Date.parse(ts));
      const message = (valid ? raw.slice(space + 1) : raw).slice(0, 2000);
      lines.push({ timestamp: valid ? new Date(ts).toISOString() : now(), level: /error|exception|fatal/i.test(message) ? 'error' : 'info', message, attributes: { pod: name } });
    }
  }
  return lines.sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-limit);
}

/** `kubectl rollout restart`: a new pod template annotation makes the Deployment replace every pod. */
export async function restartDeployment(f: typeof fetch, access: ClusterAccess, out: ResourceOutputs, signal?: AbortSignal): Promise<string> {
  const at = now();
  await kubeRequest(f, access, `/apis/apps/v1/namespaces/${seg(out.namespace)}/deployments/${seg(out.deployment)}`, {
    method: 'PATCH',
    contentType: 'application/strategic-merge-patch+json',
    body: { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': at } } } } },
    signal,
  });
  return at;
}
