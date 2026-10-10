import type { CloudTarget, TargetValidationCheck } from '@orkstage/cloud-core';

/** Non secret Render target configuration stored on the cloud target. */
export interface RenderTargetConfig {
  /** Workspace id: `tea-<id>` for a team workspace, `usr-<id>` for a personal one. */
  ownerId: string;
  /** Registry credential id (`rgc-<id>`) used to pull private images for web and private services. */
  registryCredentialId?: string;
}

/** Credential fields behind the target's `credentialRef` (a bare string becomes `apiKey`). */
export interface RenderCredentials extends Record<string, string> {
  /** Render API key (Account settings, API keys). It acts on every workspace its user belongs to. */
  apiKey: string;
}

/** Regions accepted by the Render API for services, Postgres and Key Value. */
export const RENDER_REGIONS = ['oregon', 'ohio', 'virginia', 'frankfurt', 'singapore'] as const;
export type RenderRegion = (typeof RENDER_REGIONS)[number];

export const RENDER_API = 'https://api.render.com/v1';

export function renderConfig(target: CloudTarget): RenderTargetConfig {
  return target.config as unknown as RenderTargetConfig;
}

export function isRenderRegion(region: string): region is RenderRegion {
  return (RENDER_REGIONS as readonly string[]).includes(region);
}

/** Offline checks on the target configuration (no API calls). */
export function configChecks(target: CloudTarget, region: string): TargetValidationCheck[] {
  const checks: TargetValidationCheck[] = [];
  const cfg = renderConfig(target);
  checks.push(
    typeof cfg.ownerId === 'string' && /^(tea|usr)-[a-z0-9]+$/.test(cfg.ownerId)
      ? { name: 'Workspace', status: 'ok', message: `Workspace ${cfg.ownerId} configured.` }
      : { name: 'Workspace', status: 'error', message: 'Set ownerId to the workspace id (tea-<id> or usr-<id>), shown in the workspace settings.' },
  );
  if (cfg.registryCredentialId !== undefined && !/^rgc-[a-z0-9]+$/.test(String(cfg.registryCredentialId))) {
    checks.push({ name: 'Registry credential', status: 'error', message: 'registryCredentialId must look like rgc-<id>.' });
  }
  if (!target.allowedRegions.includes(region)) {
    checks.push({ name: 'Region', status: 'error', message: `${region} is not allowed for this target.` });
  } else if (!isRenderRegion(region)) {
    checks.push({ name: 'Region', status: 'error', message: `${region} is not a Render region. Use one of: ${RENDER_REGIONS.join(', ')}.` });
  } else {
    checks.push({ name: 'Region', status: 'ok', message: `${region} is a Render region.` });
  }
  return checks;
}
