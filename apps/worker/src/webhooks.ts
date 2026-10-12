// SPDX-License-Identifier: AGPL-3.0-only
import type { NotificationJob } from '@orkstage/contracts';
import {
  SecretBox,
  sendWebhook,
  WEBHOOK_DISABLE_AFTER_FAILURES,
  WEBHOOK_RETRY_DELAYS_S,
} from '@orkstage/runtime';
import { createHash } from 'node:crypto';
import type { WorkerContext } from './context.js';

const BATCH = 50;

/** UUID-shaped (version 8, name-based) id from a stable key. */
function deterministicUuid(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Outbound webhooks (docs/specs/integration-api.md). Events become rows in the delivery outbox;
 * `deliverDue` sends what is due, retries with backoff, and disables endpoints that keep failing.
 */
export class WebhookDispatcher {
  private readonly box: SecretBox;

  constructor(private readonly ctx: WorkerContext) {
    this.box = new SecretBox(ctx.config.ENCRYPTION_KEY, ctx.config.SESSION_SECRET);
  }

  /**
   * Queue one delivery per enabled endpoint subscribed to the event for this tenant. Delivery ids
   * derive from the job id, so a retried notification job never duplicates deliveries.
   */
  async enqueue(jobId: string, job: NotificationJob): Promise<number> {
    const { prisma } = this.ctx;
    const tenant = await prisma.tenant.findUnique({ where: { id: job.tenantId }, select: { organizationId: true } });
    if (!tenant) return 0;
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: {
        enabled: true,
        events: { has: job.event },
        organizationId: tenant.organizationId,
        OR: [{ tenantId: job.tenantId }, { tenantId: null }],
      },
      select: { id: true },
    });
    if (endpoints.length === 0) return 0;
    const createdAt = new Date().toISOString();
    await prisma.webhookDelivery.createMany({
      skipDuplicates: true,
      data: endpoints.map((e) => {
        const id = deterministicUuid(`${jobId}:${e.id}`);
        return {
          id,
          endpointId: e.id,
          event: job.event,
          payload: { id, type: job.event, createdAt, tenantId: job.tenantId, data: { title: job.title, body: job.body, link: job.link ?? null, ...(job.data ?? {}) } },
        };
      }),
    });
    return endpoints.length;
  }

  async deliverDue(): Promise<void> {
    const { prisma, logger, config } = this.ctx;
    const due = await prisma.webhookDelivery.findMany({
      where: { status: { in: ['PENDING', 'RETRYING'] }, nextAttemptAt: { lte: new Date() } },
      include: { endpoint: true },
      orderBy: { nextAttemptAt: 'asc' },
      take: BATCH,
    });
    for (const d of due) {
      if (!d.endpoint.enabled) {
        await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'FAILED', lastError: 'Endpoint disabled.' } });
        continue;
      }
      // Claim the row so a second worker does not send it concurrently.
      const claimed = await prisma.webhookDelivery.updateMany({ where: { id: d.id, attempts: d.attempts, status: d.status }, data: { attempts: d.attempts + 1 } });
      if (claimed.count === 0) continue;

      const result = await sendWebhook({
        url: d.endpoint.url,
        secret: this.box.open(d.endpoint.secretEncrypted),
        event: d.event,
        deliveryId: d.id,
        payload: d.payload,
        allowPrivate: config.WEBHOOK_ALLOW_PRIVATE,
      });
      const attempt = d.attempts + 1;
      if (result.ok) {
        await prisma.$transaction([
          prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'SUCCEEDED', responseStatus: result.status ?? null, lastError: null, deliveredAt: new Date() } }),
          prisma.webhookEndpoint.update({ where: { id: d.endpointId }, data: { consecutiveFailures: 0 } }),
        ]);
        continue;
      }
      const delay = WEBHOOK_RETRY_DELAYS_S[attempt - 1];
      const failures = d.endpoint.consecutiveFailures + 1;
      const disable = failures >= WEBHOOK_DISABLE_AFTER_FAILURES;
      await prisma.$transaction([
        prisma.webhookDelivery.update({
          where: { id: d.id },
          data: {
            status: delay === undefined ? 'FAILED' : 'RETRYING',
            responseStatus: result.status ?? null,
            lastError: result.error ?? 'Delivery failed',
            ...(delay === undefined ? {} : { nextAttemptAt: new Date(Date.now() + delay * 1000) }),
          },
        }),
        prisma.webhookEndpoint.update({
          where: { id: d.endpointId },
          data: { consecutiveFailures: failures, ...(disable ? { enabled: false, disabledReason: `Disabled after ${failures} consecutive failed deliveries.` } : {}) },
        }),
      ]);
      if (disable) logger.warn({ endpointId: d.endpointId }, 'webhook endpoint disabled after repeated failures');
    }
  }
}
