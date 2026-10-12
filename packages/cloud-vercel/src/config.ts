// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudTarget, TargetValidationCheck } from '@orkstage/cloud-core';

/** Non secret Vercel target configuration stored on the cloud target. */
export interface VercelTargetConfig {
  /** Team id (`team_...`). Omit to deploy into the personal account that owns the token. */
  teamId?: string;
}

/** Credential fields behind the target's `credentialRef` (a bare string becomes `token`). */
export interface VercelCredentials extends Record<string, string> {
  /** Vercel access token, created under Account settings, Tokens, scoped to the team. */
  token: string;
}

export const VERCEL_API = 'https://api.vercel.com';

/** Compute regions where Vercel Functions can run (https://vercel.com/docs/regions). */
export const VERCEL_REGIONS = [
  'arn1',
  'bom1',
  'cdg1',
  'cle1',
  'cpt1',
  'dub1',
  'fra1',
  'gru1',
  'hkg1',
  'hnd1',
  'iad1',
  'icn1',
  'kix1',
  'lhr1',
  'pdx1',
  'sfo1',
  'sin1',
  'syd1',
  'yul1',
] as const;

export function vercelConfig(target: CloudTarget): VercelTargetConfig {
  const raw = (target.config ?? {}) as Record<string, unknown>;
  return typeof raw.teamId === 'string' && raw.teamId.length > 0 ? { teamId: raw.teamId } : {};
}

/** Offline checks on the target configuration (no API calls). */
export function configChecks(target: CloudTarget, region: string): TargetValidationCheck[] {
  const checks: TargetValidationCheck[] = [];
  const teamId = (target.config ?? {}).teamId;
  if (teamId === undefined || teamId === '') {
    checks.push({ name: 'Team', status: 'ok', message: 'No teamId: projects go to the personal account that owns the token.' });
  } else if (typeof teamId === 'string' && /^team_[A-Za-z0-9]+$/.test(teamId)) {
    checks.push({ name: 'Team', status: 'ok', message: `Team ${teamId} configured.` });
  } else {
    checks.push({ name: 'Team', status: 'error', message: 'teamId must be a Vercel team id such as team_abc123 (Team settings, General, Team ID).' });
  }
  if (!target.allowedRegions.includes(region)) {
    checks.push({ name: 'Region', status: 'error', message: `${region} is not allowed for this target.` });
  } else if (!(VERCEL_REGIONS as readonly string[]).includes(region)) {
    checks.push({ name: 'Region', status: 'error', message: `${region} is not a Vercel Functions region. Use one of: ${VERCEL_REGIONS.join(', ')}.` });
  } else {
    checks.push({ name: 'Region', status: 'ok', message: `Functions run in ${region}.` });
  }
  return checks;
}
