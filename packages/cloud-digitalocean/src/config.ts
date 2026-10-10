import type { CloudTarget, TargetValidationCheck } from '@orkstage/cloud-core';

/** Non secret DigitalOcean target configuration stored on the cloud target. */
export interface DigitalOceanTargetConfig {
  /** Spaces bucket holding OpenTofu state. Must already exist. */
  stateBucket: string;
  /** Spaces region of the state bucket, e.g. `nyc3`. */
  stateRegion: string;
}

/** Fields of the credential secret behind `credentialRef`. */
export type DigitalOceanCredentials = {
  /** Personal access token (or a custom scoped token) for the DigitalOcean API. */
  token: string;
  /** Spaces access key, used for OpenTofu state and Spaces buckets. */
  spacesAccessKeyId: string;
  spacesSecretAccessKey: string;
};

export const CREDENTIAL_FIELDS: (keyof DigitalOceanCredentials)[] = ['token', 'spacesAccessKeyId', 'spacesSecretAccessKey'];

export function digitalOceanConfig(target: CloudTarget): DigitalOceanTargetConfig {
  return target.config as unknown as DigitalOceanTargetConfig;
}

export const spacesEndpoint = (region: string) => `https://${region}.digitaloceanspaces.com`;

/**
 * Spaces signs requests as us-east-1 whatever the datacenter; the endpoint selects the region
 * (as DigitalOcean documents for the OpenTofu S3 backend).
 */
export const SPACES_SIGNING_REGION = 'us-east-1';

const REGION = /^[a-z]{3}[0-9]$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * App Platform region code for a datacenter slug (`nyc3` runs in `nyc`). App Platform has no
 * region outside these codes.
 */
export const APP_REGION: Record<string, string> = {
  ams: 'ams',
  atl: 'atl',
  blr: 'blr',
  fra: 'fra',
  lon: 'lon',
  nyc: 'nyc',
  sfo: 'sfo',
  sgp: 'sgp',
  syd: 'syd',
  tor: 'tor',
};

export function appRegionFor(region: string): string | undefined {
  return APP_REGION[region.replace(/[0-9]+$/, '')];
}

/**
 * The one datacenter per App Platform region whose VPCs an app can join directly. A VPC
 * elsewhere (nyc3, sfo2, ams2) is out of reach of the app without VPC peering.
 */
export const APP_VPC_DATACENTER: Record<string, string> = {
  ams: 'ams3',
  atl: 'atl1',
  blr: 'blr1',
  fra: 'fra1',
  lon: 'lon1',
  nyc: 'nyc1',
  sfo: 'sfo3',
  sgp: 'sgp1',
  syd: 'syd1',
  tor: 'tor1',
};

export function appCanJoinVpc(region: string): boolean {
  const app = appRegionFor(region);
  return Boolean(app && APP_VPC_DATACENTER[app] === region);
}

/** Checks of the target configuration that need no network. */
export function configChecks(target: CloudTarget): TargetValidationCheck[] {
  const cfg = target.config as Partial<Record<keyof DigitalOceanTargetConfig, unknown>>;
  const checks: TargetValidationCheck[] = [];
  if (typeof cfg.stateBucket !== 'string' || !BUCKET.test(cfg.stateBucket)) {
    checks.push({ name: 'State bucket', status: 'error', message: 'stateBucket must be the name of an existing Spaces bucket (3 to 63 lowercase letters, digits or dashes).' });
  }
  if (typeof cfg.stateRegion !== 'string' || !REGION.test(cfg.stateRegion)) {
    checks.push({ name: 'State region', status: 'error', message: 'stateRegion must be the Spaces region slug of the state bucket, e.g. nyc3.' });
  }
  return checks;
}
