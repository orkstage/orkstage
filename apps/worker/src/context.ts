// SPDX-License-Identifier: AGPL-3.0-only
import type { AdapterRegistry } from '@orkstage/cloud-core';
import type { NotificationJob } from '@orkstage/contracts';
import type { PrismaClient } from '@orkstage/database';
import type { PlatformConfig } from '@orkstage/runtime';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

/** Explicit dependencies for worker components (no hidden globals). */
export interface WorkerContext {
  config: PlatformConfig;
  prisma: PrismaClient;
  redis: Redis;
  registry: AdapterRegistry;
  logger: Logger;
  notifications: Queue<NotificationJob>;
}

export async function systemAudit(
  ctx: WorkerContext,
  e: { tenantId?: string | null; resourceType: string; resourceId?: string; action: string; result?: string; correlationId?: string; changes?: Record<string, unknown> },
) {
  await ctx.prisma.auditEvent.create({
    data: {
      actorType: 'SYSTEM',
      actorLabel: 'system',
      tenantId: e.tenantId ?? null,
      resourceType: e.resourceType,
      resourceId: e.resourceId ?? null,
      action: e.action,
      result: e.result ?? 'SUCCESS',
      correlationId: e.correlationId ?? null,
      changes: (e.changes ?? undefined) as object | undefined,
    },
  });
}

export async function notify(ctx: WorkerContext, job: NotificationJob) {
  await ctx.notifications.add('notify', job, { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 });
}
