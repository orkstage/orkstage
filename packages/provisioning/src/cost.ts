import type { CloudCapability } from '@orkstage/cloud-core';
import type { TemplateResource } from '@orkstage/templates';
import type { CostEstimate, CostLine } from './types.js';

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
  return { currency: 'USD', period: 'monthly', total, confidence, lines };
}
