// SPDX-License-Identifier: AGPL-3.0-only
import type { InstanceResource } from '@orkstage/database';
import { deriveInstanceHealth, healthToStatus, worstStatus, type HealthState, type StatusState } from '@orkstage/domain';
import type { WorkerContext } from './context.js';

/**
 * Customer-facing components derived from logical resources. Customers see "API" and
 * "Database", not "ALB" or "Flexible Server" (spec §26, §40).
 */
function componentFor(r: InstanceResource): { name: string; position: number } | null {
  switch (r.type) {
    case 'compute.container-service':
      return r.critical ? { name: 'API', position: 0 } : { name: 'Workers', position: 1 };
    case 'ingress':
      return { name: 'API', position: 0 };
    case 'web.frontend':
      return { name: 'Website', position: 0 };
    case 'database.postgresql':
      return { name: 'Database', position: 2 };
    case 'cache.redis':
      return { name: 'Cache', position: 3 };
    case 'queue':
      return { name: 'Messaging', position: 4 };
    case 'object-storage':
      return { name: 'Storage', position: 5 };
    case 'dns':
      return { name: 'DNS & TLS', position: 6 };
    default:
      return null; // networks and registries are not customer-facing components
  }
}

/**
 * Updates the status components of an instance from the health of its resources. While a
 * maintenance window covers a component (by name, or all of them when the window names none), it
 * shows MAINTENANCE. Returns the resource ids under maintenance, which open no incidents.
 */
export async function syncStatusComponents(ctx: WorkerContext, instanceId: string, tenantId: string, now = new Date()): Promise<Set<string>> {
  const [resources, windows] = await Promise.all([
    ctx.prisma.instanceResource.findMany({ where: { instanceId, status: 'ACTIVE' } }),
    ctx.prisma.maintenanceWindow.findMany({ where: { tenantId, startsAt: { lte: now }, endsAt: { gt: now }, OR: [{ instanceId }, { instanceId: null }] } }),
  ]);
  const groups = new Map<string, { position: number; resources: InstanceResource[] }>();
  for (const r of resources) {
    const c = componentFor(r);
    if (!c) continue;
    if (!groups.has(c.name)) groups.set(c.name, { position: c.position, resources: [] });
    groups.get(c.name)!.resources.push(r);
  }

  const inMaintenance = new Set<string>();
  const covered = (name: string) => windows.some((w) => w.componentNames.length === 0 || w.componentNames.includes(name));
  for (const [name, g] of groups) {
    const critical = g.resources.some((r) => r.critical);
    const maintenance = covered(name);
    if (maintenance) for (const r of g.resources) inMaintenance.add(r.resourceId);
    const status: StatusState = maintenance ? 'MAINTENANCE' : worstStatus(g.resources.map((r) => healthToStatus(r.health as HealthState, r.critical)));
    await ctx.prisma.statusComponent.upsert({
      where: { instanceId_name: { instanceId, name } },
      update: { resourceIds: g.resources.map((r) => r.resourceId), status, critical, position: g.position },
      create: { tenantId, instanceId, name, resourceIds: g.resources.map((r) => r.resourceId), status, critical, position: g.position },
    });
  }
  // A window without component names covers resources that have no component too.
  if (windows.some((w) => w.componentNames.length === 0)) for (const r of resources) inMaintenance.add(r.resourceId);
  await ctx.prisma.statusComponent.deleteMany({ where: { instanceId, name: { notIn: [...groups.keys()] } } });
  return inMaintenance;
}

export function instanceHealth(resources: InstanceResource[]): HealthState {
  return deriveInstanceHealth(
    resources.filter((r) => r.status === 'ACTIVE').map((r) => ({ componentId: r.resourceId, state: r.health as HealthState, critical: r.critical })),
  );
}
