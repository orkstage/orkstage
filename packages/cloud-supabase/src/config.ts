// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudTarget, TargetValidationCheck } from '@orkstage/cloud-core';

/** Non secret Supabase target configuration stored on the cloud target. */
export interface SupabaseTargetConfig {
  /** Organization slug, as returned by `GET /v1/organizations` and shown in the dashboard URL. */
  organizationId: string;
}

/** Credential fields behind the target's `credentialRef` (a bare string becomes `token`). */
export interface SupabaseCredentials extends Record<string, string> {
  /** Personal access token (starts with sbp_) or OAuth access token for the Management API. */
  token: string;
}

/** Region codes accepted by `POST /v1/projects` (region_selection, type `specific`). */
export const SUPABASE_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'sa-east-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-north-1',
  'eu-central-1',
  'eu-central-2',
  'ap-east-1',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ap-northeast-2',
] as const;

export const MANAGEMENT_API = 'https://api.supabase.com';

export function supabaseConfig(target: CloudTarget): SupabaseTargetConfig {
  return target.config as unknown as SupabaseTargetConfig;
}

/** Offline checks on the target configuration (no API calls). */
export function configChecks(target: CloudTarget, region: string): TargetValidationCheck[] {
  const checks: TargetValidationCheck[] = [];
  const org = supabaseConfig(target).organizationId;
  checks.push(
    typeof org === 'string' && /^[\w-]+$/.test(org)
      ? { name: 'Organization', status: 'ok', message: `Organization ${org} configured.` }
      : { name: 'Organization', status: 'error', message: 'Set organizationId to the organization slug (letters, digits, dashes, underscores).' },
  );
  if (!target.allowedRegions.includes(region)) {
    checks.push({ name: 'Region', status: 'error', message: `${region} is not allowed for this target.` });
  } else if (!(SUPABASE_REGIONS as readonly string[]).includes(region)) {
    checks.push({ name: 'Region', status: 'error', message: `${region} is not a Supabase region. Use one of: ${SUPABASE_REGIONS.join(', ')}.` });
  } else {
    checks.push({ name: 'Region', status: 'ok', message: `${region} is a Supabase region.` });
  }
  return checks;
}

export const projectHost = (ref: string) => `db.${ref}.supabase.co`;
export const apiUrl = (ref: string) => `https://${ref}.supabase.co`;
export const dashboardUrl = (ref: string) => `https://supabase.com/dashboard/project/${ref}`;
export const s3Endpoint = (ref: string) => `${apiUrl(ref)}/storage/v1/s3`;
