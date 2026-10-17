// SPDX-License-Identifier: AGPL-3.0-only
import type { InstanceResource, MaintenanceWindow } from '@orkstage/database';
import { describe, expect, it } from 'vitest';
import type { WorkerContext } from './context.js';
import { Notifier } from './notifier.js';
import { syncStatusComponents } from './status.js';

const resource = (resourceId: string, type: string, health = 'HEALTHY', critical = true) => ({ resourceId, type, health, critical, status: 'ACTIVE' }) as unknown as InstanceResource;
const window = (over: Partial<MaintenanceWindow> = {}) => ({ id: 'w1', tenantId: 't1', instanceId: null, componentNames: [], ...over }) as MaintenanceWindow;

function statusCtx(resources: InstanceResource[], windows: MaintenanceWindow[]) {
  const components = new Map<string, string>();
  const prisma = {
    instanceResource: { findMany: async () => resources },
    maintenanceWindow: { findMany: async () => windows },
    statusComponent: {
      upsert: async ({ create }: { create: { name: string; status: string } }) => void components.set(create.name, create.status),
      deleteMany: async () => ({ count: 0 }),
    },
  };
  return { ctx: { prisma } as unknown as WorkerContext, components };
}

describe('status components and maintenance (open item 8)', () => {
  const resources = [resource('api', 'compute.container-service', 'UNHEALTHY'), resource('db', 'database.postgresql'), resource('net', 'network')];

  it('derives component status from health outside maintenance', async () => {
    const { ctx, components } = statusCtx(resources, []);
    const inMaintenance = await syncStatusComponents(ctx, 'i1', 't1');
    expect(components.get('API')).toBe('MAJOR_OUTAGE');
    expect(components.get('Database')).toBe('OPERATIONAL');
    expect(inMaintenance.size).toBe(0);
  });

  it('shows MAINTENANCE on the named components only, and reports their resources', async () => {
    const { ctx, components } = statusCtx(resources, [window({ componentNames: ['API'] })]);
    const inMaintenance = await syncStatusComponents(ctx, 'i1', 't1');
    expect(components.get('API')).toBe('MAINTENANCE');
    expect(components.get('Database')).toBe('OPERATIONAL');
    expect([...inMaintenance]).toEqual(['api']);
  });

  it('covers every resource when the window names no components', async () => {
    const { ctx, components } = statusCtx(resources, [window()]);
    const inMaintenance = await syncStatusComponents(ctx, 'i1', 't1');
    expect(components.get('Database')).toBe('MAINTENANCE');
    expect([...inMaintenance].sort()).toEqual(['api', 'db', 'net']);
  });
});

describe('status page subscribers (open item 8)', () => {
  function notifierWith(page: { visibility: string; slug: string | null } | null) {
    const sent: { to: string; subject: string; text: string }[] = [];
    const subscribers = [
      { id: 's-member', email: 'member@acme.test', userId: 'u1', confirmedAt: new Date() },
      { id: 's-public', email: 'reader@example.test', userId: null, confirmedAt: new Date() },
    ];
    const prisma = {
      statusPage: { findUnique: async () => (page ? { id: 'p1', tenantId: 't1', title: null, tenant: { name: 'Acme' }, ...page } : null) },
      statusSubscription: {
        findMany: async ({ where }: { where: { userId?: { not: null } } }) => subscribers.filter((s) => !where.userId || s.userId !== null),
      },
      incident: {
        findUnique: async () => ({ id: 'inc1', instanceId: 'i1', source: 'AUTOMATED', status: 'INVESTIGATING', title: 'web cpu > 90 on Acme production', impact: 'DEGRADED', updates: [{ status: 'INVESTIGATING', message: 'Automated: cpu avg is 99 (rule)', createdById: null }] }),
      },
      instance: { findUnique: async () => ({ name: 'Acme production' }) },
    };
    const ctx = { prisma, config: { WEB_PUBLIC_URL: 'https://console.example.test/', SESSION_SECRET: 's'.repeat(40), SMTP_PORT: 25 } } as unknown as WorkerContext;
    const notifier = new Notifier(ctx, { add: async (_name: string, job: { to: string; subject: string; text: string }) => void sent.push(job) } as never);
    return { notifier, sent };
  }
  const opened = { tenantId: 't1', event: 'incident.opened' as const, title: 'web cpu > 90 on Acme production', body: 'internal', data: { incidentId: 'inc1' } };

  it('emails every confirmed subscriber of a public page, without internal detail', async () => {
    const { notifier, sent } = notifierWith({ visibility: 'PUBLIC', slug: 'acme' });
    await notifier.notifySubscribers(opened);
    expect(sent.map((s) => s.to)).toEqual(['member@acme.test', 'reader@example.test']);
    expect(sent[0]!.subject).toBe('[Acme] Investigating: Degraded performance on Acme production');
    expect(sent[0]!.text).toContain('We detected a problem and are looking into it.');
    expect(sent[0]!.text).not.toMatch(/cpu|Automated/);
    expect(sent[0]!.text).toContain('https://console.example.test/s/acme');
    expect(sent[0]!.text).toMatch(/\/s\/unsubscribe\/s-member\.[\w-]+/);
  });

  it('emails only members while the page is not public', async () => {
    const { notifier, sent } = notifierWith({ visibility: 'CUSTOMER_ONLY', slug: null });
    await notifier.notifySubscribers(opened);
    expect(sent.map((s) => s.to)).toEqual(['member@acme.test']);
    expect(sent[0]!.text).toContain('https://console.example.test/status/t1');
  });

  it('sends nothing for other events or tenants without a page', async () => {
    const a = notifierWith({ visibility: 'PUBLIC', slug: 'acme' });
    await a.notifier.notifySubscribers({ ...opened, event: 'deployment.succeeded' });
    expect(a.sent).toHaveLength(0);
    const b = notifierWith(null);
    await b.notifier.notifySubscribers(opened);
    expect(b.sent).toHaveLength(0);
  });
});
