// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { WorkerContext } from './context.js';
import type { EmailMessage } from './email.js';
import { Notifier } from './notifier.js';

interface Delivery {
  id: string;
  status: string;
  attempts: number;
  sentAt: Date | null;
  lastError: string | null;
  notification: { userId: string; title: string; body: string; link: string | null; user: { email: string } };
}

describe('email rate limit (open item 16)', () => {
  it('sends up to the hourly limit per person and keeps the rest in the console', async () => {
    const deliveries: Delivery[] = [1, 2, 3].map((n) => ({
      id: `d${n}`,
      status: 'PENDING',
      attempts: 0,
      sentAt: null,
      lastError: null,
      notification: { userId: 'u1', title: `Event ${n}`, body: 'Body', link: null, user: { email: 'owner@acme.test' } },
    }));
    const prisma = {
      notificationDelivery: {
        findMany: async () => deliveries.filter((d) => d.status === 'PENDING'),
        count: async () => deliveries.filter((d) => d.status === 'SENT').length,
        update: async ({ where, data }: { where: { id: string }; data: Partial<Delivery> }) => Object.assign(deliveries.find((d) => d.id === where.id)!, data),
      },
    };
    const sent: EmailMessage[] = [];
    const ctx = { prisma, logger: { warn: () => {} }, config: { EMAIL_RATE_LIMIT_PER_HOUR: 2, WEB_PUBLIC_URL: 'https://console.example.test' } } as unknown as WorkerContext;
    const notifier = new Notifier(ctx, undefined, { send: async (m) => void sent.push(m) });

    await notifier.deliverPending();
    expect(sent.map((m) => m.subject)).toEqual(['Event 1', 'Event 2']);
    expect(deliveries.map((d) => d.status)).toEqual(['SENT', 'SENT', 'SKIPPED']);
    expect(deliveries[2]!.lastError).toMatch(/More than 2 emails in an hour/);
  });
});
