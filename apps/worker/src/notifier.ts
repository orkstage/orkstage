// SPDX-License-Identifier: AGPL-3.0-only
import type { InvitationEmailJob, NotificationJob, StatusEmailJob } from '@orkstage/contracts';
import { publicIncidentTitle, publicIncidentUpdate } from '@orkstage/domain';
import { platformMetrics, unsubscribeToken } from '@orkstage/runtime';
import type { Queue } from 'bullmq';
import type { WorkerContext } from './context.js';
import { emailSender, type EmailSender } from './email.js';

const MAX_EMAIL_ATTEMPTS = 5;

/** Events that status page subscribers hear about. */
const SUBSCRIBER_EVENTS = new Set(['incident.opened', 'incident.updated', 'incident.resolved', 'maintenance.scheduled', 'maintenance.started', 'maintenance.completed']);

/**
 * Turns a notification request into in-app notifications plus email deliveries. Deliveries are
 * an outbox: a failed email is retried on later ticks without duplicating in-app notifications.
 */
export class Notifier {
  private readonly mail: EmailSender;

  constructor(
    private readonly ctx: WorkerContext,
    private readonly emails?: Pick<Queue<StatusEmailJob>, 'add'>,
    mail?: EmailSender,
  ) {
    this.mail = mail ?? emailSender(ctx.config);
  }

  async handle(job: NotificationJob): Promise<void> {
    const { prisma } = this.ctx;
    const [members, staff] = await Promise.all([
      prisma.membership.findMany({ where: { tenantId: job.tenantId, role: { in: ['CustomerOwner', 'CustomerAdmin'] } }, select: { userId: true } }),
      prisma.user.findMany({ where: { platformRole: { in: ['PlatformOwner', 'PlatformAdmin'] }, disabledAt: null }, select: { id: true } }),
    ]);
    const userIds = [...new Set([...members.map((m) => m.userId), ...staff.map((u) => u.id)])];
    const prefs = await prisma.notificationPreference.findMany({ where: { userId: { in: userIds }, event: job.event } });
    const enabled = (userId: string, channel: string) => prefs.find((p) => p.userId === userId && p.channel === channel)?.enabled ?? true;

    for (const userId of userIds) {
      if (!enabled(userId, 'in_app') && !enabled(userId, 'email')) continue;
      await prisma.notification.create({
        data: {
          tenantId: job.tenantId,
          userId,
          event: job.event,
          title: job.title,
          body: job.body,
          link: job.link,
          ...(enabled(userId, 'in_app') ? {} : { readAt: new Date() }),
          deliveries: enabled(userId, 'email') ? { create: { channel: 'email' } } : undefined,
        },
      });
    }
    await this.deliverPending();
    await this.notifySubscribers(job);
  }

  /**
   * One email per confirmed subscriber of the tenant's status page, through the email queue so a
   * failed send retries alone. Incidents read as on the public page: automated ones carry no
   * internal detail. Subscribers from the public page hear only while the page is public.
   */
  async notifySubscribers(job: NotificationJob): Promise<void> {
    if (!this.emails || !SUBSCRIBER_EVENTS.has(job.event)) return;
    const { prisma, config } = this.ctx;
    const page = await prisma.statusPage.findUnique({ where: { tenantId: job.tenantId }, include: { tenant: { select: { name: true } } } });
    if (!page) return;
    const subscribers = await prisma.statusSubscription.findMany({
      where: { statusPageId: page.id, confirmedAt: { not: null }, ...(page.visibility === 'PUBLIC' ? {} : { userId: { not: null } }) },
    });
    if (subscribers.length === 0) return;

    const name = page.title ?? page.tenant.name;
    let subject = `[${name}] ${job.title}`;
    let body = job.body;
    const incidentId = typeof job.data?.incidentId === 'string' ? job.data.incidentId : null;
    if (incidentId) {
      const incident = await prisma.incident.findUnique({ where: { id: incidentId }, include: { updates: { orderBy: { at: 'desc' }, take: 1 } } });
      if (!incident) return;
      const instance = incident.instanceId ? await prisma.instance.findUnique({ where: { id: incident.instanceId }, select: { name: true } }) : null;
      const title = publicIncidentTitle(incident, instance?.name);
      const status = incident.status === 'RESOLVED' ? 'Resolved' : incident.status.charAt(0) + incident.status.slice(1).toLowerCase();
      subject = `[${name}] ${status}: ${title}`;
      body = incident.updates[0] ? publicIncidentUpdate(incident.updates[0]) : body;
    }
    const base = config.WEB_PUBLIC_URL.replace(/\/+$/, '');
    const pageLink = page.visibility === 'PUBLIC' && page.slug ? `${base}/s/${page.slug}` : `${base}/status/${job.tenantId}`;
    for (const s of subscribers) {
      const unsubscribe = `${base}/s/unsubscribe/${unsubscribeToken(config.SESSION_SECRET, s.id)}`;
      const text = `${body}\n\nStatus page: ${pageLink}\n\nYou receive this because you subscribed to updates from ${name}. Unsubscribe: ${unsubscribe}`;
      await this.emails.add(
        'status',
        { kind: 'status', to: s.email, subject, text },
        { attempts: 5, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true, removeOnFail: true },
      );
    }
  }

  async sendStatusEmail(job: StatusEmailJob): Promise<void> {
    await this.mail.send({ to: job.to, subject: job.subject, text: job.text });
  }

  /** An invitation to someone who may not have an account yet. Throws so the queue retries. */
  async sendInvitation(job: InvitationEmailJob): Promise<void> {
    const expires = new Date(job.expiresAt).toUTCString();
    await this.mail.send({
      to: job.to,
      subject: `${job.inviterName} invited you to ${job.tenantName} on OrkStage`,
      text: `${job.inviterName} invited you to join ${job.tenantName} on OrkStage as ${job.role.replace('Customer', '').toLowerCase()}.

Accept the invitation: ${job.link}

Sign in with this email address (${job.to}). The link works once and expires on ${expires}. If you did not expect it, ignore this email.`,
    });
  }

  async deliverPending(): Promise<void> {
    const { prisma, logger } = this.ctx;
    const pending = await prisma.notificationDelivery.findMany({
      where: { channel: 'email', status: { in: ['PENDING', 'FAILED'] }, attempts: { lt: MAX_EMAIL_ATTEMPTS } },
      include: { notification: { include: { user: true } } },
      take: 50,
    });
    const limit = this.ctx.config.EMAIL_RATE_LIMIT_PER_HOUR;
    const sentLastHour = new Map<string, number>();
    for (const d of pending) {
      const n = d.notification;
      // Email rate limit per person (open item 16): past it, the notification stays in the console only.
      if (!sentLastHour.has(n.userId)) {
        sentLastHour.set(n.userId, await prisma.notificationDelivery.count({ where: { channel: 'email', status: 'SENT', sentAt: { gte: new Date(Date.now() - 3_600_000) }, notification: { userId: n.userId } } }));
      }
      if (sentLastHour.get(n.userId)! >= limit) {
        await prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: 'SKIPPED', lastError: `More than ${limit} emails in an hour; shown in the console only.` } });
        continue;
      }
      const link = n.link ? `${this.ctx.config.WEB_PUBLIC_URL}${n.link}` : this.ctx.config.WEB_PUBLIC_URL;
      try {
        await this.mail.send({
          to: n.user.email,
          subject: n.title,
          text: `${n.body}\n\nOpen in the console: ${link}\n\nYou receive this because you are responsible for this environment.`,
        });
        await prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: 'SENT', sentAt: new Date(), attempts: d.attempts + 1, lastError: null } });
        sentLastHour.set(n.userId, sentLastHour.get(n.userId)! + 1);
      } catch (err) {
        const message = (err as Error).message.slice(0, 300);
        logger.warn({ deliveryId: d.id, err: message }, 'email delivery failed');
        platformMetrics.notificationFailed('email');
        await prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: 'FAILED', attempts: d.attempts + 1, lastError: message } });
      }
    }
  }
}
