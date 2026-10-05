import type { InstanceResource } from '@co/database';
import { deriveInstanceHealth, healthToStatus, worstStatus, type HealthState, type StatusState } from '@co/domain';
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

export async function syncStatusComponents(ctx: WorkerContext, instanceId: string, tenantId: string): Promise<void> {
  const resources = await ctx.prisma.instanceResource.findMany({ where: { instanceId, status: 'ACTIVE' } });
  const groups = new Map<string, { position: number; resources: InstanceResource[] }>();
  for (const r of resources) {
    const c = componentFor(r);
    if (!c) continue;
    if (!groups.has(c.name)) groups.set(c.name, { position: c.position, resources: [] });
    groups.get(c.name)!.resources.push(r);
  }

  for (const [name, g] of groups) {
    const critical = g.resources.some((r) => r.critical);
    const statuses = g.resources.map((r) => healthToStatus(r.health as HealthState, r.critical));
    const status: StatusState = worstStatus(statuses);
    await ctx.prisma.statusComponent.upsert({
      where: { instanceId_name: { instanceId, name } },
      update: { resourceIds: g.resources.map((r) => r.resourceId), status, critical, position: g.position },
      create: { tenantId, instanceId, name, resourceIds: g.resources.map((r) => r.resourceId), status, critical, position: g.position },
    });
  }
  await ctx.prisma.statusComponent.deleteMany({ where: { instanceId, name: { notIn: [...groups.keys()] } } });
}

export function instanceHealth(resources: InstanceResource[]): HealthState {
  return deriveInstanceHealth(
    resources.filter((r) => r.status === 'ACTIVE').map((r) => ({ componentId: r.resourceId, state: r.health as HealthState, critical: r.critical })),
  );
}
