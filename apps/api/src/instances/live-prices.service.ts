// SPDX-License-Identifier: AGPL-3.0-only
import { type CloudCapability, type LivePriceTable, pricingInRegion } from '@orkstage/cloud-core';
import type { LivePricing, SlotBinding } from '@orkstage/provisioning';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Adapters, REDIS } from '../infra/infra.module.js';

/** Live prices are kept a day; a provider that could not answer is not asked again for an hour. */
const KEPT_SECONDS = 24 * 3600;
const RETRY_SECONDS = 3600;
/** A plan never waits longer than this for prices: the bundled table answers instead. */
const WAIT_MS = 8000;

/**
 * Live list prices for the regions an instance is placed in (ADR 0010), from the providers whose
 * adapters can read their pricing API (AWS today), cached per provider and region in Redis. The
 * compiler uses them first; any capability, region or provider without them falls back to the
 * bundled table, so prices never block a plan.
 */
@Injectable()
export class LivePrices {
  private readonly log = new Logger(LivePrices.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly adapters: Adapters,
  ) {}

  async forBindings(bindings: Record<string, SlotBinding>): Promise<(capability: CloudCapability, region: string) => LivePricing | undefined> {
    const tables = new Map<string, LivePriceTable>();
    const seen = new Set<string>();
    for (const { target, region } of Object.values(bindings)) {
      const key = `${target.provider}:${region}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const table = await this.table(target, region);
      if (table) tables.set(key, table);
    }
    return (capability, region) => {
      const table = tables.get(`${capability.provider}:${region}`);
      const own = table?.prices[capability.capability];
      if (!table || !own) return undefined;
      const base = capability.pricing ?? { currency: 'USD' as const, baseMonthly: 0, source: '' };
      return {
        pricing: pricingInRegion({ ...base, regions: { [region]: own } }, region).pricing,
        source: `${capability.provider.toUpperCase()} pricing API, ${region}, on demand, approximate${own.derived ? ' (derived)' : ''}. Not an invoice.`,
        asOf: table.asOf,
      };
    };
  }

  private async table(target: SlotBinding['target'], region: string): Promise<LivePriceTable | null> {
    const adapter = this.adapters.registry.has(target.provider) ? this.adapters.registry.get(target.provider) : undefined;
    if (!adapter?.livePrices) return null;
    const key = `prices:${target.provider}:${region}`;
    const cached = await this.redis.get(key);
    if (cached) return cached === 'unavailable' ? null : (JSON.parse(cached) as LivePriceTable);
    try {
      const table = await adapter.livePrices({ target, region, correlationId: `prices-${region}`, signal: AbortSignal.timeout(WAIT_MS) });
      if (!table) return null;
      await this.redis.set(key, JSON.stringify(table), 'EX', KEPT_SECONDS);
      return table;
    } catch (err) {
      // Missing permission (pricing:GetProducts), throttling or a timeout: the bundled table answers.
      this.log.warn(`live prices for ${target.provider} ${region} unavailable: ${(err as Error).message}`);
      await this.redis.set(key, 'unavailable', 'EX', RETRY_SECONDS);
      return null;
    }
  }
}
