// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { CloudProviderAdapter, ProviderContext, ResourceRequest } from '../types.js';

export interface ContractFixture {
  adapter: CloudProviderAdapter;
  context: ProviderContext;
  /** A request for a resource the adapter can create in this test environment. */
  sampleRequest: ResourceRequest;
}

/**
 * Behaviour every provider adapter must share (spec §47, provider contract tests). Run it from
 * each adapter package with a fixture pointing at a safe environment (simulation, LocalStack,
 * or a dedicated test account).
 */
export function runAdapterContract(name: string, makeFixture: () => ContractFixture | Promise<ContractFixture>): void {
  describe(`${name} — provider adapter contract`, () => {
    it('publishes a well-formed capability catalog', async () => {
      const { adapter, context } = await makeFixture();
      const catalog = adapter.capabilities(context.target);
      expect(catalog.length).toBeGreaterThan(0);
      for (const cap of catalog) {
        expect(cap.serviceKind).toBeTruthy();
        expect(cap.capability).toBeTruthy();
        expect(cap.regions === '*' || cap.regions.length > 0).toBe(true);
      }
      const kinds = new Set(catalog.map((c) => c.serviceKind));
      for (const kind of kinds) {
        expect(catalog.filter((c) => c.serviceKind === kind && c.isDefault).length, `${kind} default`).toBeLessThanOrEqual(1);
      }
    });

    it('validates its target and reports individual checks', async () => {
      const { adapter, context } = await makeFixture();
      const result = await adapter.validateTarget(context);
      expect(result.checks.length).toBeGreaterThan(0);
      expect(result.ok).toBe(result.checks.every((c) => c.status === 'ok' || c.status === 'skipped'));
    });

    it('ensureResource is idempotent for the same idempotency key', async () => {
      const { adapter, context, sampleRequest } = await makeFixture();
      const first = await adapter.ensureResource(context, sampleRequest);
      const second = await adapter.ensureResource(context, sampleRequest);
      expect(second.providerResourceId).toBe(first.providerResourceId);
      expect(second.unchanged).toBe(true);
      await adapter.deleteResource(context, { ...sampleRequest, providerResourceId: first.providerResourceId });
    });

    it('reports actual state, and deletion is idempotent', async () => {
      const { adapter, context, sampleRequest } = await makeFixture();
      const created = await adapter.ensureResource(context, sampleRequest);
      const ident = { ...sampleRequest, providerResourceId: created.providerResourceId };
      expect((await adapter.getResource(context, ident)).exists).toBe(true);
      await adapter.deleteResource(context, ident);
      await adapter.deleteResource(context, ident);
      expect((await adapter.getResource(context, ident)).exists).toBe(false);
    });
  });
}
