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
  maintenanceState,
  uptimeDays,
  uptimeOf,
  certificateState,
  domainRecords,
  dueExpiryNotice,
  isWithinZone,
  publicIncidentTitle,
  publicIncidentUpdate,
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

describe('public status page', () => {
  it('hides the internals of automated incidents', () => {
    expect(publicIncidentTitle({ source: 'AUTOMATED', title: 'web cpu > 90 on Acme', impact: 'DEGRADED' }, 'Acme production')).toBe('Degraded performance on Acme production');
    expect(publicIncidentTitle({ source: 'AUTOMATED', title: 'API unavailable', impact: 'MAJOR_OUTAGE' })).toBe('Service disruption');
    expect(publicIncidentTitle({ source: 'MANUAL', title: 'Slow logins', impact: 'DEGRADED' }, 'Acme')).toBe('Slow logins');
    expect(publicIncidentUpdate({ status: 'INVESTIGATING', message: 'Automated: 3 failed checks (rule)', createdById: null })).toBe('We detected a problem and are looking into it.');
    expect(publicIncidentUpdate({ status: 'MONITORING', message: 'A fix is out.', createdById: 'u1' })).toBe('A fix is out.');
  });
  it('places a maintenance window in time', () => {
    const w = { startsAt: new Date('2026-10-20T10:00:00Z'), endsAt: new Date('2026-10-20T11:00:00Z') };
    expect(maintenanceState(w, new Date('2026-10-20T09:59:00Z'))).toBe('scheduled');
    expect(maintenanceState(w, new Date('2026-10-20T10:00:00Z'))).toBe('in_progress');
    expect(maintenanceState(w, new Date('2026-10-20T11:00:00Z'))).toBe('completed');
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

describe('custom domains', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const days = (n: number) => new Date(now.getTime() + n * 86_400_000);

  it('lists the records the owner creates', () => {
    const records = domainRecords({ hostname: 'api.acme.com', kind: 'CUSTOM', verificationToken: 'tok', certificateRecords: [{ name: '_a.api.acme.com', type: 'CNAME', value: '_b.acm' }] }, 'prod-acme.apps.example.com');
    expect(records).toEqual([
      { purpose: 'ownership', name: '_orkstage-challenge.api.acme.com', type: 'TXT', value: 'tok' },
      { purpose: 'routing', name: 'api.acme.com', type: 'CNAME', value: 'prod-acme.apps.example.com' },
      { purpose: 'certificate', name: '_a.api.acme.com', type: 'CNAME', value: '_b.acm' },
    ]);
    expect(domainRecords({ hostname: 'x.apps.example.com', kind: 'PLATFORM', verificationToken: '' }, null)).toEqual([]);
  });

  it('knows the platform zone', () => {
    expect(isWithinZone('a.apps.example.com', 'apps.example.com')).toBe(true);
    expect(isWithinZone('apps.example.com', 'apps.example.com')).toBe(true);
    expect(isWithinZone('evilapps.example.com', 'apps.example.com')).toBe(false);
  });

  it('turns issued certificates expiring 30 days ahead', () => {
    expect(certificateState('ISSUED', days(60).toISOString(), now)).toBe('ISSUED');
    expect(certificateState('ISSUED', days(20).toISOString(), now)).toBe('EXPIRING');
    expect(certificateState('ISSUED', days(-1).toISOString(), now)).toBe('EXPIRED');
    expect(certificateState('PENDING_VALIDATION', undefined, now)).toBe('PENDING_VALIDATION');
  });

  it('sends each expiry warning once', () => {
    expect(dueExpiryNotice(days(40), null, now)).toBeNull();
    expect(dueExpiryNotice(days(29), null, now)).toBe(30);
    expect(dueExpiryNotice(days(29), 30, now)).toBeNull();
    expect(dueExpiryNotice(days(6), 30, now)).toBe(7);
    expect(dueExpiryNotice(days(-1), 7, now)).toBeNull();
  });
});

describe('uptime', () => {
  it('lists the last days, oldest first', () => {
    expect(uptimeDays(3, new Date('2026-10-17T05:00:00Z'))).toEqual(['2026-10-15', '2026-10-16', '2026-10-17']);
  });

  it('adds the checks of the resources asked for, per day and overall', () => {
    const days = ['2026-10-16', '2026-10-17'];
    const rows = [
      { resourceId: 'api', day: '2026-10-16', up: 100, total: 100 },
      { resourceId: 'api', day: '2026-10-17', up: 90, total: 100 },
      { resourceId: 'db', day: '2026-10-17', up: 0, total: 50 },
    ];
    expect(uptimeOf(rows, ['api'], days)).toEqual({ overall: 95, days: [{ day: '2026-10-16', uptime: 100 }, { day: '2026-10-17', uptime: 90 }] });
    expect(uptimeOf(rows, ['api', 'db'], days).overall).toBe(76);
    expect(uptimeOf(rows, ['cache'], days)).toEqual({ overall: null, days: [{ day: '2026-10-16', uptime: null }, { day: '2026-10-17', uptime: null }] });
  });
});
