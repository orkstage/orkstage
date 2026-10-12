// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudTarget, TargetValidationCheck } from '@orkstage/cloud-core';

/** Non secret Google Cloud target configuration stored on the cloud target. */
export interface GcpTargetConfig {
  /** Project id (not the number), e.g. `acme-prod-123`. */
  projectId: string;
  /** Existing GCS bucket that holds OpenTofu state. Never created by the platform. */
  stateBucket: string;
}

/** Fields of a service account key JSON file. Only `client_email` and `private_key` are required. */
export type GcpCredentials = {
  type?: string;
  project_id?: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
} & Record<string, string>;

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
const REGION = /^[a-z]+-[a-z]+\d+$/;

export function gcpConfig(target: CloudTarget): GcpTargetConfig {
  return target.config as unknown as GcpTargetConfig;
}

/** Checks of the target configuration that need no network. */
export function gcpConfigChecks(target: CloudTarget): TargetValidationCheck[] {
  const cfg = gcpConfig(target);
  const checks: TargetValidationCheck[] = [];
  if (typeof cfg.projectId !== 'string' || !PROJECT_ID.test(cfg.projectId)) {
    checks.push({ name: 'Project id', status: 'error', message: 'projectId must be a Google Cloud project id (6 to 30 lowercase letters, digits or dashes).' });
  }
  if (typeof cfg.stateBucket !== 'string' || !BUCKET.test(cfg.stateBucket) || cfg.stateBucket.includes('google')) {
    checks.push({ name: 'State bucket', status: 'error', message: 'stateBucket must be the name of an existing GCS bucket.' });
  }
  const badRegions = target.allowedRegions.filter((r) => !REGION.test(r));
  if (badRegions.length) {
    checks.push({ name: 'Regions', status: 'error', message: `Not Google Cloud regions: ${badRegions.join(', ')}. Use names like us-central1 or southamerica-east1.` });
  }
  return checks;
}

/**
 * Tags as Google Cloud labels: keys and values lowercase letters, digits, `_` and `-`, at most
 * 63 characters, keys starting with a letter (`platform:managed` becomes `platform_managed`).
 */
export function labelsFrom(tags: Record<string, string>): Record<string, string> {
  const clean = (v: string) => v.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 63);
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    let key = clean(k);
    if (!/^[a-z]/.test(key)) key = `k_${key}`.slice(0, 63);
    labels[key] = clean(v);
  }
  return labels;
}
