// SPDX-License-Identifier: AGPL-3.0-only
import { AdapterRegistry } from '@orkstage/cloud-core';
import { InMemoryMockStateStore, MockAdapter } from '@orkstage/cloud-mock';
import type { AlertRule, InstanceResource } from '@orkstage/database';
import { describe, expect, it } from 'vitest';
import type { WorkerContext } from './context.js';
import { aggregate, compare, MetricAlerts } from './metric-alerts.js';

interface Incident {
  id: string;
  dedupKey: string;
  status: string;
  title: string;
  severity: string;
  openedAt: Date;
  resolvedAt: Date | null;
}

const target = { id: 't-sim', provider: 'mock', name: 'Simulated AWS', config: { simulate: 'aws' }, credentialRef: null, allowedRegions: ['us-east-1'], defaultRegion: 'us-east-1', environment: 'any' };
const instance = { id: 'i1', tenantId: 'tenant-1', name: 'Acme production' };
const api = { resourceId: 'api', type: 'compute.container-service', provider: 'mock', targetId: 't-sim', region: 'us-east-1', capability: 'ecs-fargate', name: 'ork-acme-prod-api', critical: true, providerResourceId: 'sim-1', outputs: {} } as unknown as InstanceResource;
const db = { ...api, resourceId: 'db', type: 'database.postgresql', name: 'ork-acme-prod-db' } as unknown as InstanceResource;

function rule(over: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'rule-cpu',
    tenantId: null,
    name: 'API CPU above 80%',
    condition: { signal: 'metric', metric: 'cpu', resourceTypes: ['compute.container-service'], operator: '>', threshold: 80, windowMinutes: 5, statistic: 'avg' },
    severity: 'high',
    actions: ['create_incident', 'notify_owners'],
    cooldownSeconds: 900,
    autoResolve: true,
    enabled: true,
    createdAt: new Date(),
    ...over,
  } as AlertRule;
}

function setup() {
  const incidents: Incident[] = [];
  const notifications: string[] = [];
  let clock = Date.parse('2026-10-17T12:00:00Z');
  const matches = (i: Incident, where: { dedupKey: string; status?: { not: string }; resolvedAt?: { gte: Date } }) =>
    i.dedupKey === where.dedupKey &&
    (!where.status || i.status !== where.status.not) &&
    (!where.resolvedAt || (i.resolvedAt !== null && i.resolvedAt >= where.resolvedAt.gte));
  const prisma = {
    incident: {
      findFirst: async ({ where }: { where: Parameters<typeof matches>[1] }) => incidents.find((i) => matches(i, where)) ?? null,
      create: async ({ data }: { data: Omit<Incident, 'id' | 'status' | 'openedAt' | 'resolvedAt'> }) => {
        const row = { ...data, id: `inc-${incidents.length + 1}`, status: 'INVESTIGATING', openedAt: new Date(clock), resolvedAt: null };
        incidents.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: { status: string; resolvedAt: Date } }) => {
        const row = incidents.find((i) => i.id === where.id)!;
        Object.assign(row, { status: data.status, resolvedAt: new Date(clock) });
        return row;
      },
    },
    auditEvent: { create: async () => ({}) },
  };
  const mock = new MockAdapter(new InMemoryMockStateStore(), { sleep: async () => {} });
  const ctx = {
    prisma,
    registry: new AdapterRegistry().register(mock),
    logger: { warn: () => {} },
    notifications: { add: async (_n: string, job: { event: string }) => void notifications.push(job.event) },
  } as unknown as WorkerContext;
  const alerts = new MetricAlerts(ctx, () => clock);
  const targets = new Map([[target.id, target as never]]);
  const pin = (value: number | null) => mock.setMetricOverride({ target: target as never, region: 'us-east-1', correlationId: 'c' }, api.name, 'cpu', value);
  const tick = async (rules: AlertRule[], minutesLater = 1) => {
    clock += minutesLater * 60_000;
    await alerts.evaluate(instance, [api, db], rules, targets);
  };
  return { incidents, notifications, pin, tick };
}

describe('metric alerts (open item 7)', () => {
  it('aggregates and compares', () => {
    expect(aggregate([10, 20, 60])).toBe(30);
    expect(aggregate([10, 20, 60], 'max')).toBe(60);
    expect(compare(80, '>', 80)).toBe(false);
    expect(compare(80, '>=', 80)).toBe(true);
    expect(compare(5, '<', 10)).toBe(true);
  });

  it('opens one incident on a simulated breach, and resolves it on recovery', async () => {
    const s = setup();
    await s.pin(95);
    await s.tick([rule()]);
    expect(s.incidents).toHaveLength(1);
    expect(s.incidents[0]).toMatchObject({ dedupKey: 'metric:rule-cpu:i1:api', status: 'INVESTIGATING', severity: 'high' });
    expect(s.incidents[0]!.title).toBe('api cpu > 80 on Acme production');
    expect(s.notifications).toEqual(['incident.opened']);

    await s.tick([rule()]); // still breaching: no second incident
    expect(s.incidents).toHaveLength(1);

    await s.pin(12);
    await s.tick([rule()]);
    expect(s.incidents[0]!.status).toBe('RESOLVED');
    expect(s.notifications).toEqual(['incident.opened', 'incident.resolved']);
  });

  it('leaves the incident open when the rule does not auto resolve', async () => {
    const s = setup();
    await s.pin(95);
    await s.tick([rule({ autoResolve: false })]);
    await s.pin(12);
    await s.tick([rule({ autoResolve: false })]);
    expect(s.incidents[0]!.status).toBe('INVESTIGATING');
  });

  it('waits for the cooldown before opening the same incident again', async () => {
    const s = setup();
    await s.pin(95);
    await s.tick([rule()]);
    await s.pin(12);
    await s.tick([rule()]);
    await s.pin(95);
    await s.tick([rule()]); // 1 minute after the resolve, cooldown is 15 minutes
    expect(s.incidents).toHaveLength(1);
    await s.tick([rule()], 15);
    expect(s.incidents).toHaveLength(2);
  });

  it('reads each rule at most once a minute, and only the resource types it names', async () => {
    const s = setup();
    await s.pin(95);
    await s.tick([rule()], 0);
    await s.pin(12);
    await s.tick([rule()], 0.5); // too soon: not read again, stays open
    expect(s.incidents[0]!.status).toBe('INVESTIGATING');
    expect(s.incidents.every((i) => i.dedupKey.endsWith(':api'))).toBe(true);
  });

  it('ignores disabled rules and health rules', async () => {
    const s = setup();
    await s.pin(95);
    await s.tick([rule({ enabled: false }), rule({ id: 'h', condition: { signal: 'health', consecutiveFailures: 3 } as never })]);
    expect(s.incidents).toHaveLength(0);
  });
});
