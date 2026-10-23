// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { awsLivePrices } from './pricing-api.js';
import { type PriceDoc, regionalPrices, type RegionDocs } from './price-list.js';

type Item = { sku: string; family?: string; attributes: Record<string, string>; usd: string };

function doc(items: Item[], publicationDate = '2026-10-20T00:00:00Z'): PriceDoc {
  return {
    publicationDate,
    products: Object.fromEntries(items.map((i) => [i.sku, { productFamily: i.family, attributes: i.attributes }])),
    terms: { OnDemand: Object.fromEntries(items.map((i) => [i.sku, { t: { priceDimensions: { d: { pricePerUnit: { USD: i.usd } } } } }])) },
  };
}

/** sa-east-1 shaped documents, with the decoys the rules must skip. */
const SAO_PAULO: Record<keyof RegionDocs, Item[]> = {
  ecs: [
    { sku: 'e1', attributes: { usagetype: 'SAE1-Fargate-vCPU-Hours:perCPU' }, usd: '0.0696' },
    { sku: 'e2', attributes: { usagetype: 'SAE1-Fargate-GB-Hours' }, usd: '0.0076' },
    { sku: 'e3', attributes: { usagetype: 'SAE1-Fargate-ARM-vCPU-Hours:perCPU' }, usd: '0.05' },
  ],
  rds: [
    { sku: 'r1', family: 'Database Instance', attributes: { instanceType: 'db.t4g.micro', databaseEngine: 'PostgreSQL', deploymentOption: 'Single-AZ', usagetype: 'SAE1-InstanceUsage:db.t4g.micro' }, usd: '0.034' },
    { sku: 'r2', family: 'Database Instance', attributes: { instanceType: 'db.r7g.xlarge', databaseEngine: 'PostgreSQL', deploymentOption: 'Single-AZ', usagetype: 'SAE1-InstanceUsage:db.r7g.xl' }, usd: '0.76' },
    { sku: 'r3', family: 'Database Storage', attributes: { volumeType: 'General Purpose', databaseEngine: 'PostgreSQL', deploymentOption: 'Single-AZ' }, usd: '0.219' },
  ],
  cache: [
    { sku: 'c1', family: 'Cache Instance', attributes: { instanceType: 'cache.t4g.micro', cacheEngine: 'Valkey', usagetype: 'SAE1-SyncDurability-NodeUsage:cache.t4g.micro' }, usd: '0.003' },
    { sku: 'c2', family: 'Cache Instance', attributes: { instanceType: 'cache.t4g.micro', cacheEngine: 'Valkey', usagetype: 'SAE1-NodeUsage:cache.t4g.micro' }, usd: '0.024' },
  ],
  elb: [
    { sku: 'l1', family: 'Load Balancer-Application', attributes: { usagetype: 'SAE1-LoadBalancerUsage' }, usd: '0.034' },
    { sku: 'l2', family: 'Load Balancer-Application', attributes: { usagetype: 'SAE1-LCUUsage' }, usd: '0.011' },
  ],
};

const docs = (items: Record<keyof RegionDocs, Item[]>): RegionDocs => ({ ecs: doc(items.ecs), rds: doc(items.rds), cache: doc(items.cache), elb: doc(items.elb) });

describe('AWS regional prices (ADR 0010)', () => {
  it('reads Fargate, RDS, ElastiCache and ALB prices of a region, skipping add ons and ARM', () => {
    const prices = regionalPrices(docs(SAO_PAULO), 0.0225);
    expect(prices['ecs-fargate']).toEqual({ perUnitMonthly: { vcpu: 50.81, memoryGiB: 5.55 } });
    expect(prices['rds-postgres']).toEqual({ bySize: { micro: 24.82, xlarge: 554.8 }, perUnitMonthly: { storageGiB: 0.219 } });
    expect(prices['elasticache-valkey']).toEqual({ bySize: { micro: 17.52 } });
    expect(prices.alb).toEqual({ baseMonthly: 32.85 });
  });

  it('marks the derived prices: NAT from the ALB ratio, ECS on EC2 from Fargate', () => {
    const prices = regionalPrices(docs(SAO_PAULO), 0.0225);
    expect(prices.vpc).toEqual({ perUnitMonthly: { availabilityZone: 49.64 }, derived: true });
    expect(prices['ecs-ec2']?.derived).toBe(true);
    expect(regionalPrices(docs(SAO_PAULO)).vpc).toBeUndefined();
  });

  it('reads the same prices from the Pricing API, page by page, with filters', async () => {
    const calls: { ServiceCode?: string; Filters?: { Field: string; Value: string }[]; NextToken?: string }[] = [];
    const items: Record<string, Item[]> = { AmazonECS: SAO_PAULO.ecs, AmazonRDS: SAO_PAULO.rds, AmazonElastiCache: SAO_PAULO.cache, AWSELB: SAO_PAULO.elb };
    const client = {
      send: (async (cmd: { input: { ServiceCode: string; Filters: { Field: string; Value: string }[]; NextToken?: string } }) => {
        calls.push(cmd.input);
        const region = cmd.input.Filters.find((f) => f.Field === 'regionCode')!.Value;
        const list = region === 'us-east-1'
          ? [{ sku: 'u1', family: 'Load Balancer-Application', attributes: { usagetype: 'LoadBalancerUsage' }, usd: '0.0225' }]
          : items[cmd.input.ServiceCode]!;
        // Two pages: the first item, then the rest.
        const page = cmd.input.NextToken ? list.slice(1) : list.slice(0, 1);
        const PriceList = page.map((i) =>
          JSON.stringify({ product: { sku: i.sku, productFamily: i.family, attributes: i.attributes }, terms: { OnDemand: { t: { priceDimensions: { d: { pricePerUnit: { USD: i.usd } } } } } }, publicationDate: '2026-10-21T00:00:00Z' }),
        );
        return { PriceList, NextToken: !cmd.input.NextToken && list.length > 1 ? 'next' : undefined };
      }) as never,
    };
    const table = await awsLivePrices(client, 'sa-east-1');
    expect(table.asOf).toBe('2026-10-21');
    expect(table.prices['ecs-fargate']).toEqual({ perUnitMonthly: { vcpu: 50.81, memoryGiB: 5.55 } });
    expect(table.prices.vpc).toEqual({ perUnitMonthly: { availabilityZone: 49.64 }, derived: true });
    expect(calls.find((c) => c.ServiceCode === 'AmazonRDS')?.Filters).toEqual(
      expect.arrayContaining([expect.objectContaining({ Field: 'databaseEngine', Value: 'PostgreSQL' }), expect.objectContaining({ Field: 'regionCode', Value: 'sa-east-1' })]),
    );
    expect(calls.filter((c) => c.ServiceCode === 'AmazonECS')).toHaveLength(2);
  });
});
