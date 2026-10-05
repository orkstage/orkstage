import { describe, expect, it } from 'vitest';
import {
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
      'co-acme-prod-api',
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
