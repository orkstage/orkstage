import type { CloudTarget, TargetValidationCheck } from '@orkstage/cloud-core';

/** Regions with virtual machines, DBaaS and Object Storage. */
export const MAGALU_REGIONS = ['br-se1', 'br-ne1'] as const;

/** Non secret Magalu Cloud target configuration. */
export interface MagaluTargetConfig {
  /** Object Storage bucket holding OpenTofu state, in the target region. Must already exist. */
  stateBucket: string;
  /** Existing SSH key name for service VMs. Without it, each service gets a generated key. */
  sshKeyName?: string;
}

/** Credential secret JSON: an API key for the platform APIs and an Object Storage key pair. */
export type MagaluCredentials = {
  apiKey: string;
  stateAccessKeyId: string;
  stateSecretAccessKey: string;
};

export function magaluConfig(target: CloudTarget): MagaluTargetConfig {
  return target.config as unknown as MagaluTargetConfig;
}

/** Magalu REST API base for a region, e.g. https://api.magalu.cloud/br-se1. */
export const apiBase = (region: string) => `https://api.magalu.cloud/${region}`;

/** S3 compatible Object Storage endpoint for a region. */
export const objectStorageEndpoint = (region: string) => `https://${region}.magaluobjects.com`;

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function configChecks(target: CloudTarget): TargetValidationCheck[] {
  const cfg = magaluConfig(target);
  const checks: TargetValidationCheck[] = [];
  if (!cfg.stateBucket || !BUCKET.test(cfg.stateBucket)) {
    checks.push({ name: 'State bucket', status: 'error', message: 'stateBucket must be an Object Storage bucket name (3 to 63 lowercase letters, digits, dots or dashes).' });
  }
  const unknown = target.allowedRegions.filter((r) => !(MAGALU_REGIONS as readonly string[]).includes(r));
  if (unknown.length) {
    checks.push({ name: 'Regions', status: 'error', message: `Unknown Magalu Cloud regions: ${unknown.join(', ')}. Use ${MAGALU_REGIONS.join(' or ')}.` });
  }
  return checks;
}
