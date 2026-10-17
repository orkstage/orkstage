// SPDX-License-Identifier: AGPL-3.0-only
import type { PolicyConfig } from './types.js';

const min = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));
const max = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.max(a, b));

/**
 * The policy an instance of a tenant is held to (open item 12): the platform policy, tightened by
 * the tenant's. A tenant can narrow regions, sizes and registries, lower budgets, require more
 * labels or a newer TLS version, and keep logs longer; it can never loosen the platform policy or
 * turn a policy off.
 */
export function effectivePolicy(platform: PolicyConfig = {}, tenant: PolicyConfig = {}): PolicyConfig {
  const out: PolicyConfig = { ...platform };
  if (tenant.allowedRegions) {
    out.allowedRegions = platform.allowedRegions ? tenant.allowedRegions.filter((r) => platform.allowedRegions!.includes(r)) : [...tenant.allowedRegions];
  }
  out.maxMonthlyCostUsd = min(platform.maxMonthlyCostUsd, tenant.maxMonthlyCostUsd);
  out.maxReplicas = min(platform.maxReplicas, tenant.maxReplicas);
  if (tenant.machineSizes) {
    const same = (a: { cpu: number; memoryMiB: number }, b: { cpu: number; memoryMiB: number }) => a.cpu === b.cpu && a.memoryMiB === b.memoryMiB;
    out.machineSizes = platform.machineSizes ? tenant.machineSizes.filter((s) => platform.machineSizes!.some((p) => same(p, s))) : [...tenant.machineSizes];
  }
  if (tenant.approvedRegistries) {
    // A tenant registry counts only inside one the platform approved.
    out.approvedRegistries = platform.approvedRegistries
      ? tenant.approvedRegistries.filter((t) => platform.approvedRegistries!.some((p) => t.startsWith(p)))
      : [...tenant.approvedRegistries];
  }
  if (platform.requiredLabels || tenant.requiredLabels) out.requiredLabels = [...new Set([...(platform.requiredLabels ?? []), ...(tenant.requiredLabels ?? [])])].sort();
  if (platform.minTlsVersion || tenant.minTlsVersion) out.minTlsVersion = platform.minTlsVersion === '1.3' || tenant.minTlsVersion === '1.3' ? '1.3' : '1.2';
  out.minLogRetentionDays = max(platform.minLogRetentionDays, tenant.minLogRetentionDays);
  out.disabled = platform.disabled;
  for (const k of Object.keys(out) as (keyof PolicyConfig)[]) if (out[k] === undefined) delete out[k];
  return out;
}
