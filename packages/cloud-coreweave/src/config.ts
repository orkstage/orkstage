// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudTarget, TargetValidationCheck } from '@orkstage/cloud-core';

/** CoreWeave Cloud API base URL (CKS, VPC and identity endpoints). */
export const COREWEAVE_API = 'https://api.coreweave.com';
/** AI Object Storage primary endpoint (outside CoreWeave clusters). */
export const DEFAULT_STATE_ENDPOINT = 'https://cwobject.com';
/** AI Object Storage LOTA endpoint, the fast path from inside a CoreWeave cluster. */
export const LOTA_ENDPOINT = 'http://cwlota.com';

/** Non secret CoreWeave target configuration stored on the cloud target. */
export interface CoreWeaveTargetConfig {
  /** Existing CKS cluster that container services and ingress routes deploy into. */
  clusterName?: string;
  /** Zone of the cluster and the state bucket, e.g. `US-EAST-04A`. Defaults to the deployment region. */
  zone?: string;
  /** AI Object Storage bucket holding OpenTofu state. Must exist before deploying. */
  stateBucket: string;
  /** S3 endpoint for the state bucket. Defaults to https://cwobject.com. */
  stateEndpoint?: string;
  /** IngressClass used for ingress routes. Defaults to `traefik` (CoreWeave Traefik chart). */
  ingressClassName?: string;
  /** cert-manager ClusterIssuer for TLS routes. Defaults to `letsencrypt-prod` (CoreWeave cert-issuer chart). */
  clusterIssuer?: string;
  /**
   * DNS suffix that resolves to the ingress controller, e.g. `myorg-mycluster.coreweave.app`.
   * Defaults to `<organization id>-<clusterName>.coreweave.app`, the wildcard the Traefik chart publishes.
   */
  ingressDomain?: string;
}

/**
 * Secret JSON behind the target's credentialRef. `token` is a CoreWeave API access token
 * (`CW-SECRET-<secret>`); the state keys are an AI Object Storage access key pair. `kubeconfig`
 * (raw or base64) is only needed when the cluster should be reached with other credentials than
 * the API token, for example a private endpoint.
 */
export type CoreWeaveCredentials = {
  token: string;
  stateAccessKeyId: string;
  stateSecretAccessKey: string;
  kubeconfig?: string;
};

export function coreweaveConfig(target: CloudTarget): CoreWeaveTargetConfig {
  return target.config as unknown as CoreWeaveTargetConfig;
}

/** Zone used to sign S3 requests and to match the cluster. AI Object Storage accepts any zone name. */
export function zoneFor(cfg: CoreWeaveTargetConfig, region: string): string {
  return cfg.zone ?? region;
}

const BUCKET = /^(?!cw-|vip-)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const ZONE = /^[A-Z0-9][A-Z0-9-]{1,30}[A-Z0-9]$/;
const CLUSTER = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Checks of the target configuration that need no network. */
export function coreweaveConfigChecks(target: CloudTarget): TargetValidationCheck[] {
  const cfg = coreweaveConfig(target);
  const checks: TargetValidationCheck[] = [];
  if (!cfg.stateBucket || !BUCKET.test(cfg.stateBucket)) {
    checks.push({ name: 'State bucket', status: 'error', message: 'stateBucket must be a valid AI Object Storage bucket name (lowercase, 3 to 63 characters, not starting with cw- or vip-).' });
  }
  if (cfg.stateEndpoint !== undefined && !/^https:\/\/[^/\s]+\/?$/.test(cfg.stateEndpoint)) {
    checks.push({ name: 'State endpoint', status: 'error', message: 'stateEndpoint must be an https URL such as https://cwobject.com.' });
  }
  if (cfg.zone !== undefined && !ZONE.test(cfg.zone)) {
    checks.push({ name: 'Zone', status: 'error', message: 'zone must be a CoreWeave zone such as US-EAST-04A.' });
  }
  if (cfg.clusterName !== undefined && !CLUSTER.test(cfg.clusterName)) {
    checks.push({ name: 'Cluster', status: 'error', message: 'clusterName must be the name of a CKS cluster (lowercase letters, digits and dashes, at most 63 characters).' });
  }
  for (const r of target.allowedRegions) {
    if (!ZONE.test(r)) checks.push({ name: 'Regions', status: 'error', message: `${r} is not a CoreWeave zone. Use zone names such as US-EAST-04A.` });
  }
  return checks;
}

/** Kubernetes label key or value safe form: alphanumerics, dash, underscore and dot, at most 63 characters. */
export function labelSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 63).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
}

/** Tags as Kubernetes labels and bucket tags (`platform:managed` becomes `platform_managed`). */
export function labelsFrom(tags: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    const key = labelSafe(k);
    if (key) out[key] = labelSafe(v);
  }
  return out;
}
