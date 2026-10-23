# ADR 0010: Prices from provider pricing APIs, with bundled tables per region

**Status:** accepted on October 23, 2026 (owner decision; orkstage-dev `docs/aws-items.md`, A11).
Built for AWS: the bundled table per region (`packages/cloud-aws/src/prices.generated.ts`, from
`scripts/refresh-prices.mjs`), the live Pricing API (`livePrices` on the adapter, cached by the API),
and the source and date on every estimate. Bundled tables for the other providers are not built yet.

## Context

Cost estimates (the plan, the wizard, the customer overview) come from a static catalog in each
adapter (`packages/cloud-<provider>/src/catalog.ts`). The AWS table holds `us-east-1` on demand list
prices only, so an instance in São Paulo or Frankfurt is estimated at Virginia prices, which can be
noticeably lower than what those regions charge. The placement recommendation (open item 26) and
the FinOps agent (open item 29) both need prices per region they can trust.

## Decision

1. **One `PriceSource` interface, two kinds of source.** A live source reads the provider's pricing
   API; a bundled source reads the adapter's tables. Every estimate records which source and which
   date its prices came from, and the plan shows both.
2. **AWS uses the Pricing API first.** At plan time, `GetProducts` for the services and the region
   of the plan (the API is served from `us-east-1` and `ap-south-1`; the hub role needs
   `pricing:GetProducts`). Answers are cached per service, region and filter for 24 hours. When the
   API cannot be reached or the permission is missing, the bundled table is used and the plan says
   so.
3. **Bundled tables per provider, per service and per region.** Every adapter's catalog holds list
   prices for each service it can deploy in each region it supports, with the source and the date
   of the table. A script regenerates them at release time from the provider's public price data
   where it exists (AWS price list files, the Azure Retail Prices API, the Google Cloud Billing
   Catalog API) and from published price pages otherwise. Bundled tables are the only source for
   providers without a pricing API and the fallback for the others.
4. **What a price means.** List prices, on demand, in US dollars, before discounts, savings plans,
   credits or taxes. Estimates are labelled approximate and never presented as an invoice.
5. **Other providers go live later.** Azure Retail Prices needs no credentials and is the next live
   source; others follow when their adapters are verified on a live account (open item 3).

## Consequences

- Estimates follow the region of the plan; the placement recommendation can compare regions.
- Plans take one more call per service on a cache miss; the cache keeps it off the hot path.
- Price tables grow with regions; they are data files generated at release time, not code edited
  by hand.
- The FinOps agent reads estimates together with their source and date, so it can say how fresh a
  number is.
