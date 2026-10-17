// SPDX-License-Identifier: AGPL-3.0-only
import { AdapterRegistry } from '@orkstage/cloud-core';
import { InMemoryMockStateStore, MockAdapter } from '@orkstage/cloud-mock';
import type { Domain, InstanceResource } from '@orkstage/database';
import { describe, expect, it } from 'vitest';
import type { WorkerContext } from './context.js';
import { DomainMonitor } from './domains.js';

const target = { id: 't-sim', provider: 'mock', name: 'Simulated AWS', config: { simulate: 'aws' }, credentialRef: null, allowedRegions: ['us-east-1'], defaultRegion: 'us-east-1', environment: 'any' };
const dns = {
  id: 'r-dns',
  tenantId: 'tenant-1',
  instanceId: 'i1',
  resourceId: 'dns',
  type: 'dns',
  provider: 'mock',
  targetId: 't-sim',
  region: 'us-east-1',
  capability: 'route53',
  name: 'ork-acme-prod-dns',
  status: 'ACTIVE',
  providerResourceId: 'sim-dns',
  outputs: { fqdn: 'prod-acme.platform.example.test', custom_domains: 'api.acme.test' },
} as unknown as InstanceResource;

// The simulated certificates compare expiry with the real clock, so the test starts now.
const START = Date.now();
const daysFromStart = (n: number) => new Date(START + n * 86_400_000).toISOString();

function setup(start = START) {
  let clock = start;
  const domains: Domain[] = [];
  const events: string[] = [];
  const base = (over: Partial<Domain>): Domain =>
    ({
      id: `d${domains.length + 1}`,
      tenantId: 'tenant-1',
      instanceId: 'i1',
      resourceId: 'dns',
      kind: 'CUSTOM',
      status: 'PENDING_VERIFICATION',
      verificationToken: 'proof',
      verifiedAt: null,
      lastCheckedAt: null,
      lastError: null,
      certificateStatus: 'NONE',
      certificateExpiresAt: null,
      certificateRecords: [],
      expiryNoticeDays: null,
      createdAt: new Date(clock),
      updatedAt: new Date(clock),
      ...over,
    }) as Domain;
  const prisma = {
    instanceResource: { findMany: async () => [dns] },
    domain: {
      findUnique: async ({ where }: { where: { hostname: string } }) => domains.find((d) => d.hostname === where.hostname) ?? null,
      create: async ({ data }: { data: Partial<Domain> }) => {
        const row = base(data);
        domains.push(row);
        return row;
      },
      findMany: async ({ where }: { where: { kind?: string; status?: string; instanceId?: string } }) =>
        domains.filter((d) => (!where.kind || d.kind === where.kind) && (!where.status || d.status === where.status) && (!where.instanceId || d.instanceId === where.instanceId)),
      update: async ({ where, data }: { where: { id: string }; data: Partial<Domain> }) => Object.assign(domains.find((d) => d.id === where.id)!, data),
    },
    auditEvent: { create: async () => ({}) },
  };
  const mock = new MockAdapter(new InMemoryMockStateStore(), { sleep: async () => {} });
  const ctx = {
    prisma,
    registry: new AdapterRegistry().register(mock),
    logger: { warn: () => {} },
    notifications: { add: async (_n: string, job: { event: string }) => void events.push(job.event) },
  } as unknown as WorkerContext;
  const monitor = new DomainMonitor(ctx, async () => [], () => new Date(clock));
  const tick = async (minutes = 1) => {
    clock += minutes * 60_000;
    await monitor.tick(new Map([[target.id, target as never]]));
  };
  const add = (over: Partial<Domain>) => domains.push(base(over));
  return { domains, events, mock, tick, add };
}

describe('domain monitor (open item 9)', () => {
  it('records the platform subdomain as a verified domain', async () => {
    const s = setup();
    await s.tick();
    expect(s.domains).toHaveLength(1);
    expect(s.domains[0]).toMatchObject({ hostname: 'prod-acme.platform.example.test', kind: 'PLATFORM', status: 'VERIFIED', certificateStatus: 'ISSUED' });
  });

  it('verifies a custom domain once its TXT record appears in the simulated DNS', async () => {
    const s = setup();
    s.add({ hostname: 'api.acme.test' });
    await s.tick();
    expect(s.domains[0]).toMatchObject({ status: 'PENDING_VERIFICATION' });
    expect(s.domains[0]!.lastError).toMatch(/No TXT record/);

    await s.mock.setDnsRecord('_orkstage-challenge.api.acme.test', 'TXT', ['proof']);
    await s.tick(2);
    expect(s.domains[0]).toMatchObject({ status: 'VERIFIED', lastError: null });
    expect(s.events).toContain('domain.verified');
  });

  it('fails a custom domain whose TXT record never appears within 7 days', async () => {
    const s = setup();
    s.add({ hostname: 'late.acme.test', createdAt: new Date(daysFromStart(-8)) });
    await s.tick();
    expect(s.domains[0]!.status).toBe('FAILED');
    expect(s.events).toEqual(['domain.verification_failed']);
  });

  it('tracks the certificate and warns once per threshold before it expires', async () => {
    const s = setup();
    s.add({ hostname: 'api.acme.test', status: 'VERIFIED' });
    await s.mock.setCertificateExpiry('api.acme.test', daysFromStart(24));
    await s.tick();
    const d = s.domains.find((x) => x.hostname === 'api.acme.test')!;
    expect(d).toMatchObject({ certificateStatus: 'EXPIRING', expiryNoticeDays: 30 });
    expect(s.events.filter((e) => e === 'domain.certificate_expiring')).toHaveLength(1);

    await s.tick(11); // certificates are read every 10 minutes; still 30 day band
    expect(s.events.filter((e) => e === 'domain.certificate_expiring')).toHaveLength(1);

    await s.mock.setCertificateExpiry('api.acme.test', null); // renewed: 60 days again
    await s.tick(11);
    expect(d).toMatchObject({ certificateStatus: 'ISSUED', expiryNoticeDays: null });
  });
});
