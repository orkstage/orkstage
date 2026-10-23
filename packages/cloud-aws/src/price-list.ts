// SPDX-License-Identifier: AGPL-3.0-only
import type { RegionalPricing } from '@orkstage/cloud-core';

/**
 * AWS prices per region (ADR 0010), read the same way from the public price list files (the bundled
 * table, scripts/refresh-prices.mjs) and from the Pricing API (live, pricing-api.ts). Monthly means
 * 730 hours. Read directly: Fargate vCPU and memory, RDS for PostgreSQL Single-AZ instances and
 * General Purpose storage, ElastiCache Valkey nodes, ALB hours plus one LCU. Derived, and marked so:
 * the NAT gateway (in the EC2 price list, too large to read) follows the region's ALB price ratio
 * to us-east-1, and ECS on EC2 capacity keeps its ratio to Fargate.
 */
export interface PriceDoc {
  publicationDate?: string;
  products: Record<string, { productFamily?: string; attributes?: Record<string, string> }>;
  terms: { OnDemand: Record<string, Record<string, { priceDimensions: Record<string, { pricePerUnit: { USD?: string } }> }>> };
}

export interface RegionDocs {
  ecs: PriceDoc;
  rds: PriceDoc;
  cache: PriceDoc;
  elb: PriceDoc;
}

const HOURS = 730;
export const RDS_CLASS: Record<string, string> = { micro: 'db.t4g.micro', small: 'db.t4g.small', medium: 'db.t4g.medium', large: 'db.r7g.large', xlarge: 'db.r7g.xlarge' };
export const CACHE_NODE: Record<string, string> = { micro: 'cache.t4g.micro', small: 'cache.t4g.small', medium: 'cache.t4g.medium', large: 'cache.r7g.large' };
/** us-east-1 values the derived prices start from (catalog.ts). */
const NAT_US_EAST_1 = 32.85;
const EC2_PER_FARGATE = { vcpu: 22.0 / 29.55, memoryGiB: 2.75 / 3.24 };

const money = (n: number) => Math.round(n * 100) / 100;
const fine = (n: number) => Math.round(n * 10000) / 10000;

/** The on demand USD price of the first product that matches. */
export function onDemand(doc: PriceDoc, match: (attributes: Record<string, string>, family: string | undefined) => boolean): number | undefined {
  for (const [sku, product] of Object.entries(doc.products)) {
    if (!match(product.attributes ?? {}, product.productFamily)) continue;
    for (const term of Object.values(doc.terms.OnDemand[sku] ?? {})) {
      for (const dim of Object.values(term.priceDimensions)) {
        const usd = Number(dim.pricePerUnit.USD);
        if (usd > 0) return usd;
      }
    }
  }
  return undefined;
}

const usage = (re: RegExp) => (a: Record<string, string>) => re.test(a.usagetype ?? '');

export function albHourly(elb: PriceDoc): number | undefined {
  return onDemand(elb, (a, family) => family === 'Load Balancer-Application' && /^([A-Z0-9]+-)?LoadBalancerUsage$/.test(a.usagetype ?? ''));
}

/** Prices of one region per capability, from that region's price documents. */
export function regionalPrices(docs: RegionDocs, usEast1AlbHourly?: number): Record<string, RegionalPricing> {
  const out: Record<string, RegionalPricing> = {};
  const vcpu = onDemand(docs.ecs, usage(/^([A-Z0-9]+-)?Fargate-vCPU-Hours:perCPU$/));
  const memory = onDemand(docs.ecs, usage(/^([A-Z0-9]+-)?Fargate-GB-Hours$/));
  if (vcpu && memory) {
    out['ecs-fargate'] = { perUnitMonthly: { vcpu: money(vcpu * HOURS), memoryGiB: money(memory * HOURS) } };
    out['ecs-ec2'] = { perUnitMonthly: { vcpu: money(vcpu * HOURS * EC2_PER_FARGATE.vcpu), memoryGiB: money(memory * HOURS * EC2_PER_FARGATE.memoryGiB) }, derived: true };
  }
  const rds: Record<string, number> = {};
  for (const [size, cls] of Object.entries(RDS_CLASS)) {
    // Usage types shorten sizes (db.r7g.xl), so the instance type attribute pins the class.
    const hour = onDemand(
      docs.rds,
      (a, family) => family === 'Database Instance' && a.instanceType === cls && a.databaseEngine === 'PostgreSQL' && a.deploymentOption === 'Single-AZ' && /^([A-Z0-9]+-)?InstanceUsage:/.test(a.usagetype ?? ''),
    );
    if (hour) rds[size] = money(hour * HOURS);
  }
  const storage = onDemand(docs.rds, (a, family) => family === 'Database Storage' && a.volumeType === 'General Purpose' && a.databaseEngine === 'PostgreSQL' && a.deploymentOption === 'Single-AZ');
  if (Object.keys(rds).length) out['rds-postgres'] = { bySize: rds, ...(storage ? { perUnitMonthly: { storageGiB: fine(storage) } } : {}) };
  const cache: Record<string, number> = {};
  for (const [size, node] of Object.entries(CACHE_NODE)) {
    // Plain node hours only: the same node type also lists add ons such as SyncDurability.
    const hour = onDemand(docs.cache, (a, family) => family === 'Cache Instance' && a.instanceType === node && a.cacheEngine === 'Valkey' && /^([A-Z0-9]+-)?NodeUsage:/.test(a.usagetype ?? ''));
    if (hour) cache[size] = money(hour * HOURS);
  }
  if (Object.keys(cache).length) out['elasticache-valkey'] = { bySize: cache };
  const alb = albHourly(docs.elb);
  const lcu = onDemand(docs.elb, (a, family) => family === 'Load Balancer-Application' && /^([A-Z0-9]+-)?LCUUsage$/.test(a.usagetype ?? ''));
  if (alb && lcu) out.alb = { baseMonthly: money((alb + lcu) * HOURS) };
  if (alb && usEast1AlbHourly) out.vpc = { perUnitMonthly: { availabilityZone: money((NAT_US_EAST_1 * alb) / usEast1AlbHourly) }, derived: true };
  return out;
}
