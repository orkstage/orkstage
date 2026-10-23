// SPDX-License-Identifier: AGPL-3.0-only
import { GetProductsCommand, type PricingClient } from '@aws-sdk/client-pricing';
import type { LivePriceTable } from '@orkstage/cloud-core';
import { albHourly, type PriceDoc, regionalPrices, type RegionDocs } from './price-list.js';

/** What each price document holds: the products price-list.ts reads, filtered at the API. */
const QUERIES: Record<keyof RegionDocs, { service: string; filters: Record<string, string> }> = {
  ecs: { service: 'AmazonECS', filters: {} },
  rds: { service: 'AmazonRDS', filters: { databaseEngine: 'PostgreSQL', deploymentOption: 'Single-AZ' } },
  cache: { service: 'AmazonElastiCache', filters: { cacheEngine: 'Valkey' } },
  elb: { service: 'AWSELB', filters: { productFamily: 'Load Balancer-Application' } },
};

interface PriceListItem {
  product: { sku: string; productFamily?: string; attributes?: Record<string, string> };
  terms?: { OnDemand?: PriceDoc['terms']['OnDemand'][string] };
  publicationDate?: string;
}

/** One price document from the Pricing API, in the shape of the public price list files. */
async function priceDoc(client: Pick<PricingClient, 'send'>, query: (typeof QUERIES)[keyof RegionDocs], region: string, signal?: AbortSignal): Promise<PriceDoc> {
  const doc: PriceDoc = { products: {}, terms: { OnDemand: {} } };
  const Filters = [{ Field: 'regionCode', Value: region }, ...Object.entries(query.filters).map(([Field, Value]) => ({ Field, Value }))].map((f) => ({ Type: 'TERM_MATCH' as const, ...f }));
  let NextToken: string | undefined;
  do {
    const out = await client.send(new GetProductsCommand({ ServiceCode: query.service, Filters, NextToken, MaxResults: 100 }), { abortSignal: signal });
    for (const raw of out.PriceList ?? []) {
      const item = (typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(JSON.stringify(raw))) as PriceListItem;
      doc.products[item.product.sku] = { productFamily: item.product.productFamily, attributes: item.product.attributes };
      if (item.terms?.OnDemand) doc.terms.OnDemand[item.product.sku] = item.terms.OnDemand;
      if (item.publicationDate && (!doc.publicationDate || item.publicationDate > doc.publicationDate)) doc.publicationDate = item.publicationDate;
    }
    NextToken = out.NextToken;
  } while (NextToken);
  return doc;
}

/**
 * Prices of one region from the AWS Pricing API (ADR 0010), read with the same rules as the bundled
 * table. The NAT gateway price also needs the us-east-1 ALB price (one more query outside it).
 */
export async function awsLivePrices(client: Pick<PricingClient, 'send'>, region: string, signal?: AbortSignal): Promise<LivePriceTable> {
  const [ecs, rds, cache, elb] = await Promise.all((['ecs', 'rds', 'cache', 'elb'] as const).map((k) => priceDoc(client, QUERIES[k], region, signal)));
  const docs: RegionDocs = { ecs: ecs!, rds: rds!, cache: cache!, elb: elb! };
  const usAlb = region === 'us-east-1' ? albHourly(docs.elb) : albHourly(await priceDoc(client, QUERIES.elb, 'us-east-1', signal));
  const dates = Object.values(docs)
    .map((d) => d.publicationDate)
    .filter((d): d is string => Boolean(d))
    .sort();
  return { prices: regionalPrices(docs, usAlb), asOf: (dates.at(-1) ?? new Date().toISOString()).slice(0, 10) };
}
