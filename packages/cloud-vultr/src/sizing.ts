// SPDX-License-Identifier: AGPL-3.0-only
import { ProviderError } from '@orkstage/cloud-core';
import type { VultrDatabasePlan, VultrObjectStorageCluster, VultrObjectStorageTier } from './api.js';

/** Regular cloud compute plans (vc2), cheapest first. */
export const INSTANCE_PLANS = [
  { id: 'vc2-1c-1gb', vcpu: 1, ramMiB: 1024, monthly: 5 },
  { id: 'vc2-1c-2gb', vcpu: 1, ramMiB: 2048, monthly: 10 },
  { id: 'vc2-2c-2gb', vcpu: 2, ramMiB: 2048, monthly: 15 },
  { id: 'vc2-2c-4gb', vcpu: 2, ramMiB: 4096, monthly: 20 },
  { id: 'vc2-4c-8gb', vcpu: 4, ramMiB: 8192, monthly: 40 },
  { id: 'vc2-6c-16gb', vcpu: 6, ramMiB: 16384, monthly: 80 },
  { id: 'vc2-8c-32gb', vcpu: 8, ramMiB: 32768, monthly: 160 },
  { id: 'vc2-16c-64gb', vcpu: 16, ramMiB: 65536, monthly: 320 },
  { id: 'vc2-24c-96gb', vcpu: 24, ramMiB: 98304, monthly: 640 },
] as const;

/** Cheapest instance plan that fits the container's CPU and memory. */
export function instancePlan(cpu: number, memoryMiB: number): string {
  const plan = INSTANCE_PLANS.find((p) => p.vcpu >= cpu && p.ramMiB >= memoryMiB);
  if (!plan) {
    throw new ProviderError('VULTR_NO_INSTANCE_PLAN', `No Vultr cloud compute plan has ${cpu} vCPU and ${memoryMiB} MiB. Lower cpu or memoryMiB, or set providerOverrides.vultr.plan.`, 'VALIDATION_ERROR', 'vultr');
  }
  return plan.id;
}

/** Minimum memory per logical size, in MB. */
export const SIZE_RAM_MB: Record<string, number> = { micro: 1024, small: 2048, medium: 4096, large: 8192, xlarge: 16384 };

/** Database nodes for a spec: a standby for PostgreSQL HA, `replicas` standbys for a cache (Vultr allows up to 3 nodes). */
export function databaseNodes(serviceKind: string, spec: Record<string, unknown>): number {
  if (serviceKind === 'cache.redis') return Math.min(3, 1 + Math.max(0, Number(spec.replicas ?? 0)));
  return spec.highAvailability && spec.highAvailability !== 'none' ? 2 : 1;
}

/** Key recorded next to the chosen plan, so a later apply keeps the plan while the size is unchanged. */
export const sizeKey = (size: string, nodes: number) => `${size}/${nodes}`;

/**
 * Cheapest managed database plan for an engine in a region with at least `minRamMb` memory and
 * exactly `nodes` nodes. Plans come from `GET /v2/databases/plans`, so new plans are picked up
 * without a release.
 */
export function pickDatabasePlan(plans: VultrDatabasePlan[], engine: 'pg' | 'valkey', region: string, minRamMb: number, nodes: number): VultrDatabasePlan | undefined {
  return plans
    .filter((p) => p.supported_engines?.[engine] === true && p.locations.includes(region) && p.number_of_nodes === nodes && p.ram >= minRamMb)
    .sort((a, b) => a.monthly_cost - b.monthly_cost || a.ram - b.ram)[0];
}

/** Object Storage cluster and tier for a region: the cheapest tier, newest cluster on ties. */
export function pickObjectStorage(
  clusters: VultrObjectStorageCluster[],
  tiersByCluster: Map<number, VultrObjectStorageTier[]>,
  region: string,
): { clusterId: number; tierId: number; hostname: string } | undefined {
  let best: { clusterId: number; tierId: number; hostname: string; price: number } | undefined;
  for (const c of clusters.filter((x) => x.region === region && x.deploy === 'yes').sort((a, b) => b.id - a.id)) {
    for (const t of tiersByCluster.get(c.id) ?? []) {
      if (!best || t.price < best.price) best = { clusterId: c.id, tierId: t.id, hostname: c.hostname, price: t.price };
    }
  }
  return best && { clusterId: best.clusterId, tierId: best.tierId, hostname: best.hostname };
}
