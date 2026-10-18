// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { CloudProviderAdapter, ProviderContext, ResourceOutputs, ResourceRequest } from '../types.js';

export interface ContractFixture {
  adapter: CloudProviderAdapter;
  context: ProviderContext;
  /** A request for a resource the adapter can create in this test environment. */
  sampleRequest: ResourceRequest;
  /**
   * Credential material the fixture configured for the target (API tokens, client secrets, key
   * parts). None of it may appear in resource outputs. Leave it out only when the target needs
   * no credentials (simulation).
   */
  secrets?: string[];
  /**
   * A change to `sampleRequest` the provider can only make by replacing the resource. When the
   * adapter implements `planResource`, the plan for it must be flagged destructive. Leave it out
   * only when the adapter has no way to plan a replacement in this environment, and say why.
   */
  replacingRequest?: ResourceRequest;
  /**
   * The adapter implements `probeExists` but cannot tell for the sample resource (no provider API
   * describes it), so it answers `undefined` while the resource exists. Say why when set.
   */
  probeUndetermined?: boolean;
}

/** Output names that suggest a credential: they must hold a reference, never the value. */
const SECRET_LIKE_KEY = /password|passwd|secret|token|private_?key|api_?key|credential/i;
/** Names that say the value points somewhere else (`secret_ref`, `password_secret_arn`, `token_name`). */
const REFERENCE_KEY = /(ref|_id|Id|_arn|Arn|_name|Name)$/;
/** Values that are references: ARNs, secret store URIs without user info, Secret Manager names. */
const REFERENCE_VALUE = /^(arn:|[a-z][a-z0-9+.-]*:\/\/[^\s:@]+$|projects\/[^/]+\/secrets\/)/i;
/** A URL with a password in it, e.g. `postgres://user:pw@host/db`. */
const URL_WITH_PASSWORD = /:\/\/[^/\s:@]+:[^/\s@]+@/;

function expectNoSecrets(outputs: ResourceOutputs, secrets: string[], where: string): void {
  for (const [key, value] of Object.entries(outputs)) {
    if (typeof value !== 'string') continue;
    for (const secret of secrets) expect(value.includes(secret), `${where}.${key} holds a configured secret`).toBe(false);
    expect(URL_WITH_PASSWORD.test(value), `${where}.${key} is a URL with a password`).toBe(false);
    if (SECRET_LIKE_KEY.test(key)) expect(REFERENCE_KEY.test(key) || REFERENCE_VALUE.test(value), `${where}.${key} looks like a secret value`).toBe(true);
  }
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

    it('never puts secrets in outputs', async () => {
      const { adapter, context, sampleRequest, secrets = [] } = await makeFixture();
      const created = await adapter.ensureResource(context, sampleRequest);
      const ident = { ...sampleRequest, providerResourceId: created.providerResourceId };
      expectNoSecrets(created.outputs, secrets, 'ensureResource');
      expectNoSecrets((await adapter.getResource(context, ident)).outputs, secrets, 'getResource');
      expect(created.providerResourceId.length).toBeGreaterThan(0);
      for (const secret of secrets) expect(created.providerResourceId).not.toContain(secret);
      await adapter.deleteResource(context, ident);
    });

    it('flags plans that replace the resource as destructive', async () => {
      const { adapter, context, sampleRequest, replacingRequest } = await makeFixture();
      if (!adapter.planResource || !replacingRequest) return;
      const created = await adapter.ensureResource(context, sampleRequest);
      const same = await adapter.planResource(context, sampleRequest);
      expect(same.destructive).toBe(false);
      const replacing = await adapter.planResource(context, replacingRequest);
      expect(replacing.destructive).toBe(true);
      expect(replacing.actions.some((a) => a.action === 'replace' || a.action === 'delete')).toBe(true);
      await adapter.deleteResource(context, { ...sampleRequest, providerResourceId: created.providerResourceId });
    });

    it('probeExists sees the resource after ensure and not after delete', async () => {
      const { adapter, context, sampleRequest, probeUndetermined } = await makeFixture();
      if (!adapter.probeExists) return;
      const created = await adapter.ensureResource(context, sampleRequest);
      const ident = { ...sampleRequest, providerResourceId: created.providerResourceId, outputs: created.outputs };
      expect(await adapter.probeExists(context, ident)).toBe(probeUndetermined ? undefined : true);
      await adapter.deleteResource(context, ident);
      expect(await adapter.probeExists(context, ident)).toBe(false);
    });
  });
}
