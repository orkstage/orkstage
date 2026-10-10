import { ProviderError, requestJson } from '@orkstage/cloud-core';
import { COREWEAVE_API } from './config.js';

/** Authenticated JSON call to the CoreWeave Cloud API; `null` for a 404 when `allow404` is set. */
export type CoreWeaveApi = <T>(path: string, init?: { method?: string; allow404?: boolean }) => Promise<T | null>;

export function coreweaveApi(f: typeof fetch, token: string, signal?: AbortSignal): CoreWeaveApi {
  return (path, init = {}) =>
    requestJson(`${COREWEAVE_API}${path}`, {
      fetch: f,
      signal,
      method: init.method ?? 'GET',
      allow404: init.allow404,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
}

/** Organization and principal behind the API token (`GET /v1beta1/auth/whoami`). */
export async function whoAmI(api: CoreWeaveApi): Promise<{ orgUid: string; uid?: string }> {
  const r = await api<{ principal?: { orgUid?: string; uid?: string } }>('/v1beta1/auth/whoami');
  if (!r?.principal?.orgUid) throw new Error('CoreWeave did not report an organization for this token.');
  return { orgUid: r.principal.orgUid, uid: r.principal.uid };
}

export interface CksCluster {
  id: string;
  name: string;
  zone?: string;
  status?: string;
  apiServerEndpoint?: string;
}

export async function listClusters(api: CoreWeaveApi): Promise<CksCluster[]> {
  const r = await api<{ items?: CksCluster[] }>('/v1beta1/cks/clusters');
  return r?.items ?? [];
}

/** The CKS cluster with this name (and zone, when given). Throws a validation error when absent. */
export async function findCluster(api: CoreWeaveApi, name: string, zone?: string): Promise<CksCluster> {
  const all = await listClusters(api);
  const found = all.find((c) => c.name === name && (!zone || !c.zone || c.zone === zone)) ?? all.find((c) => c.name === name);
  if (!found) {
    throw new ProviderError('COREWEAVE_CLUSTER_NOT_FOUND', `No CKS cluster named ${name} is visible to this token.`, 'VALIDATION_ERROR', 'coreweave');
  }
  return found;
}

/** API server URL of a cluster; the CKS API reports it with or without a scheme. */
export function apiServerUrl(cluster: CksCluster): string {
  const endpoint = cluster.apiServerEndpoint ?? '';
  if (!endpoint) {
    throw new ProviderError('COREWEAVE_CLUSTER_PRIVATE', `CKS cluster ${cluster.name} has no API server endpoint (private clusters need a kubeconfig in the credential secret).`, 'VALIDATION_ERROR', 'coreweave');
  }
  return /^https?:\/\//.test(endpoint) ? endpoint.replace(/\/$/, '') : `https://${endpoint}`;
}

export const CLUSTER_RUNNING = 'STATUS_RUNNING';
