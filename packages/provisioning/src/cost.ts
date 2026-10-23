// SPDX-License-Identifier: AGPL-3.0-only
import { type CloudCapability, pricingInRegion } from '@orkstage/cloud-core';
import type { TemplateResource } from '@orkstage/templates';
import type { CostEstimate, CostLine, LivePricing } from './types.js';

const CATEGORY: Record<string, CostLine['category']> = {
  'compute.container-service': 'compute',
  'database.postgresql': 'database',
  'cache.redis': 'cache',
  'object-storage': 'storage',
  'container-registry': 'storage',
  network: 'network',
  ingress: 'network',
  dns: 'network',
  queue: 'messaging',
  'web.frontend': 'compute',
};

/**
 * Approximate monthly cost of one resource from static catalog pricing. Returns null when the
 * capability has no pricing; estimates are never presented as invoices (spec §32).
 */
export function estimateResourceMonthly(resource: TemplateResource, cap: CloudCapability): number | null {
  const p = cap.pricing;
  if (!p) return null;
  const unit = p.perUnitMonthly ?? {};
  let total = p.baseMonthly;

  switch (resource.type) {
    case 'compute.container-service':
      total += ((unit.vcpu ?? 0) * resource.cpu + (unit.memoryGiB ?? 0) * (resource.memoryMiB / 1024)) * resource.replicas;
      break;
    case 'database.postgresql': {
      const instance = p.bySize?.[resource.size];
      if (instance === undefined) return null;
      total += instance * (resource.highAvailability === 'none' ? 1 : (p.haMultiplier ?? 1));
      total += (unit.storageGiB ?? 0) * resource.storageGiB;
      break;
    }
    case 'cache.redis': {
      const node = p.bySize?.[resource.size];
      if (node === undefined) return null;
      total += node * (1 + resource.replicas);
      break;
    }
    case 'network':
      if (resource.natGateway) total += (unit.availabilityZone ?? 0) * resource.availabilityZones;
      break;
    default:
      break;
  }
  return Math.round(total * 100) / 100;
}

export function categoryOf(type: string): CostLine['category'] {
  return CATEGORY[type] ?? 'other';
}

export function summarizeCost(lines: CostLine[]): CostEstimate {
  const priced = lines.filter((l) => l.monthly !== null);
  const total = Math.round(priced.reduce((sum, l) => sum + (l.monthly ?? 0), 0) * 100) / 100;
  const confidence = priced.length === 0 ? 'unavailable' : priced.length === lines.length ? 'approximate' : 'partial';
  const sources = new Map(priced.map((l) => [`${l.source}|${l.asOf ?? ''}`, { source: l.source, asOf: l.asOf ?? null }]));
  return { currency: 'USD', period: 'monthly', total, confidence, lines, sources: [...sources.values()] };
}

/**
 * The price of one resource in its region (ADR 0010): live prices when the caller has them, else the
 * capability's table for the region, else its default prices, saying which one it used.
 */
export function priceLine(resource: TemplateResource, cap: CloudCapability, region: string, live?: LivePricing): Pick<CostLine, 'monthly' | 'source' | 'asOf'> {
  if (live) return { monthly: estimateResourceMonthly(resource, { ...cap, pricing: live.pricing }), source: live.source, asOf: live.asOf };
  if (!cap.pricing) return { monthly: null, source: 'No pricing data', asOf: null };
  const regional = pricingInRegion(cap.pricing, region);
  const where = regional.region ? `${region}${regional.derived ? ', derived' : ''}` : `no table for ${region}, default region prices`;
  return { monthly: estimateResourceMonthly(resource, { ...cap, pricing: regional.pricing }), source: `${cap.pricing.source} (${where})`, asOf: cap.pricing.asOf ?? null };
}
