// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudTarget, TargetValidationCheck } from '@orkstage/cloud-core';

/** Non secret Vultr target configuration stored on the cloud target. */
export interface VultrTargetConfig {
  /** Object Storage bucket holding OpenTofu state. Must exist before the first deployment. */
  stateBucket: string;
  /** Object Storage hostname of that bucket's subscription, e.g. `ewr1.vultrobjects.com`. */
  stateEndpoint: string;
}

/** Signing region for Vultr Object Storage; the service accepts any region name. */
export const STATE_SIGNING_REGION = 'us-east-1';

export function vultrConfig(target: CloudTarget): VultrTargetConfig {
  return target.config as unknown as VultrTargetConfig;
}

export const stateEndpointUrl = (cfg: VultrTargetConfig) => `https://${cfg.stateEndpoint}`;

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const REGION = /^[a-z]{3}$/;

/** Checks of the target configuration that need no network. */
export function vultrConfigChecks(target: CloudTarget): TargetValidationCheck[] {
  const cfg = vultrConfig(target);
  const checks: TargetValidationCheck[] = [];
  checks.push(
    typeof cfg.stateBucket === 'string' && BUCKET.test(cfg.stateBucket)
      ? { name: 'State bucket', status: 'ok', message: `OpenTofu state goes to bucket ${cfg.stateBucket}.` }
      : { name: 'State bucket', status: 'error', message: 'stateBucket must be an Object Storage bucket name (3 to 63 lowercase letters, digits, dots or dashes).' },
  );
  checks.push(
    typeof cfg.stateEndpoint === 'string' && HOSTNAME.test(cfg.stateEndpoint)
      ? { name: 'State endpoint', status: 'ok', message: `Object Storage at ${cfg.stateEndpoint}.` }
      : { name: 'State endpoint', status: 'error', message: 'stateEndpoint must be the Object Storage hostname without a scheme, e.g. ewr1.vultrobjects.com.' },
  );
  const badRegions = [...target.allowedRegions, target.defaultRegion].filter((r) => !REGION.test(r));
  if (badRegions.length) {
    checks.push({ name: 'Regions', status: 'error', message: `Use Vultr region ids such as ewr, ord, sao or fra (not: ${[...new Set(badRegions)].join(', ')}).` });
  }
  return checks;
}
