// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  CLOUD_PROVIDERS,
  isFeatureFlag,
  isProviderEnabled,
  providerFlagKey,
  resolveFeatureFlags,
  readTenantLimits,
  tenantFeatures,
  assertInstanceTransition,
  canStartDeployment,
  canStartDestroy,
  deriveInstanceHealth,
  desiredStateHash,
  operationKey,
  resourceName,
  stableStringify,
  summarizeSteps,
  worstStatus,
  isRetryable,
} from './index.js';

describe('instance lifecycle', () => {
  it('allows the happy path from DRAFT to READY', () => {
    const path = [
      'DRAFT',
      'VALIDATING',
      'PLANNING',
      'PROVISIONING',
      'DEPLOYING',
      'CONFIGURING',
      'VERIFYING',
      'READY',
    ] as const;
    for (let i = 1; i < path.length; i++) {
      expect(() => assertInstanceTransition(path[i - 1]!, path[i]!)).not.toThrow();
    }
  });

  it('rejects skipping straight to READY', () => {
    expect(() => assertInstanceTransition('DRAFT', 'READY')).toThrow(/cannot transition/);
  });

  it('never leaves DESTROYED', () => {
    expect(canStartDeployment('DESTROYED')).toBe(false);
    expect(canStartDestroy('DESTROYED')).toBe(false);
  });

  it('allows redeploy after a failure and destroy from READY', () => {
    expect(canStartDeployment('PROVISION_FAILED')).toBe(true);
    expect(canStartDestroy('READY')).toBe(true);
    expect(canStartDeployment('PROVISIONING')).toBe(false);
  });
});

describe('deployment summaries', () => {
  it('reports partial failure when some steps succeeded', () => {
    expect(summarizeSteps(['SUCCEEDED', 'FAILED', 'SKIPPED'])).toBe('PARTIALLY_FAILED');
  });
  it('reports failure when nothing succeeded', () => {
    expect(summarizeSteps(['FAILED', 'SKIPPED'])).toBe('FAILED');
  });
  it('reports success only when every step succeeded', () => {
    expect(summarizeSteps(['SUCCEEDED', 'SUCCEEDED'])).toBe('SUCCEEDED');
  });
});

describe('health derivation', () => {
  it('is UNHEALTHY when a critical component is down', () => {
    expect(
      deriveInstanceHealth([
        { componentId: 'api', state: 'UNHEALTHY', critical: true },
        { componentId: 'db', state: 'HEALTHY', critical: true },
      ]),
    ).toBe('UNHEALTHY');
  });
  it('is only DEGRADED when a non-critical component is down', () => {
    expect(
      deriveInstanceHealth([
        { componentId: 'api', state: 'HEALTHY', critical: true },
        { componentId: 'cache', state: 'UNHEALTHY', critical: false },
      ]),
    ).toBe('DEGRADED');
  });
  it('is UNKNOWN with no components', () => {
    expect(deriveInstanceHealth([])).toBe('UNKNOWN');
  });
  it('picks the worst status for the headline', () => {
    expect(worstStatus(['OPERATIONAL', 'PARTIAL_OUTAGE', 'DEGRADED'])).toBe('PARTIAL_OUTAGE');
    expect(worstStatus([])).toBe('OPERATIONAL');
  });
});

describe('idempotency', () => {
  it('hashes equal objects equally regardless of key order', () => {
    expect(desiredStateHash({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(
      desiredStateHash({ b: { d: [1, 2], c: 2 }, a: 1 }),
    );
    expect(stableStringify({ b: 1, a: undefined })).toBe('{"b":1}');
  });
  it('produces a different operation key when desired state changes', () => {
    const k1 = operationKey('t1', 'i1', desiredStateHash({ replicas: 1 }));
    const k2 = operationKey('t1', 'i1', desiredStateHash({ replicas: 2 }));
    expect(k1).not.toBe(k2);
    expect(k1).toBe(operationKey('t1', 'i1', desiredStateHash({ replicas: 1 })));
  });
});

describe('naming', () => {
  it('builds deterministic names', () => {
    expect(resourceName({ tenantSlug: 'acme', instanceSlug: 'prod', resourceId: 'api' })).toBe(
      'ork-acme-prod-api',
    );
  });
  it('respects provider length limits with a stable hash suffix', () => {
    const parts = { tenantSlug: 'a'.repeat(40), instanceSlug: 'b'.repeat(40), resourceId: 'database' };
    const name = resourceName(parts, 32);
    expect(name.length).toBeLessThanOrEqual(32);
    expect(resourceName(parts, 32)).toBe(name);
  });
});

describe('failure classes', () => {
  it('only retries transient failures', () => {
    expect(isRetryable('PROVIDER_RATE_LIMIT')).toBe(true);
    expect(isRetryable('POLICY_VIOLATION')).toBe(false);
  });
});

describe('feature flags', () => {
  it('ships AWS and simulation on, every other provider off', () => {
    const flags = resolveFeatureFlags([]);
    expect(isProviderEnabled(flags, 'aws')).toBe(true);
    expect(isProviderEnabled(flags, 'mock')).toBe(true);
    expect(CLOUD_PROVIDERS.filter((p) => isProviderEnabled(flags, p))).toEqual(['aws', 'mock']);
  });

  it('turns the tenant features on by default, and off through overrides (ADR 0007)', () => {
    expect(tenantFeatures(resolveFeatureFlags([], 't1'))).toEqual({ multiCloud: true, multiRegion: true, autoscaling: true, customDomains: true });
    const off = [
      { key: 'MULTI_CLOUD', tenantId: null, enabled: false },
      { key: 'AUTOSCALING', tenantId: 't1', enabled: false },
    ];
    expect(tenantFeatures(resolveFeatureFlags(off, 't1'))).toEqual({ multiCloud: false, multiRegion: true, autoscaling: false, customDomains: true });
    expect(tenantFeatures(resolveFeatureFlags(off, 't2')).autoscaling).toBe(true);
  });

  it('reads stored tenant limits, keeping only known non negative numbers', () => {
    expect(readTenantLimits({ maxInstances: 3, maxVcpuPerInstance: 2.5, maxReplicasPerService: -1, other: 9, maxDomainsPerInstance: '2' })).toEqual({ maxInstances: 3, maxVcpuPerInstance: 2.5 });
    expect(readTenantLimits(null)).toEqual({});
  });

  it('lets a tenant override win over the platform value', () => {
    const overrides = [
      { key: providerFlagKey('azure'), tenantId: null, enabled: true },
      { key: providerFlagKey('azure'), tenantId: 't1', enabled: false },
      { key: providerFlagKey('vercel'), tenantId: 't2', enabled: true },
    ];
    expect(isProviderEnabled(resolveFeatureFlags(overrides), 'azure')).toBe(true);
    expect(isProviderEnabled(resolveFeatureFlags(overrides, 't1'), 'azure')).toBe(false);
    expect(isProviderEnabled(resolveFeatureFlags(overrides, 't2'), 'vercel')).toBe(true);
    expect(isProviderEnabled(resolveFeatureFlags(overrides, 't1'), 'vercel')).toBe(false);
  });

  it('knows its own keys', () => {
    expect(isFeatureFlag('PROVIDER_GCP')).toBe(true);
    expect(isFeatureFlag('PROVIDER_NOPE')).toBe(false);
  });
});
