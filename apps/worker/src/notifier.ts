import type { NotificationJob } from '@orkstage/contracts';
import nodemailer, { type Transporter } from 'nodemailer';
import type { WorkerContext } from './context.js';

const MAX_EMAIL_ATTEMPTS = 5;

/**
 * Turns a notification request into in-app notifications plus email deliveries. Deliveries are
 * an outbox: a failed email is retried on later ticks without duplicating in-app notifications.
 */
export class Notifier {
  private readonly mail: Transporter;

  constructor(private readonly ctx: WorkerContext) {
    this.mail = nodemailer.createTransport({
      host: ctx.config.SMTP_HOST,
      port: ctx.config.SMTP_PORT,
      secure: ctx.config.SMTP_SECURE,
    });
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
  }

  async deliverPending(): Promise<void> {
    const { prisma, logger } = this.ctx;
    const pending = await prisma.notificationDelivery.findMany({
      where: { channel: 'email', status: { in: ['PENDING', 'FAILED'] }, attempts: { lt: MAX_EMAIL_ATTEMPTS } },
      include: { notification: { include: { user: true } } },
      take: 50,
    });
    for (const d of pending) {
      const n = d.notification;
      const link = n.link ? `${this.ctx.config.WEB_PUBLIC_URL}${n.link}` : this.ctx.config.WEB_PUBLIC_URL;
      try {
        await this.mail.sendMail({
          from: this.ctx.config.EMAIL_FROM,
          to: n.user.email,
          subject: n.title,
          text: `${n.body}\n\nOpen in the console: ${link}\n\nYou receive this because you are responsible for this environment.`,
        });
        await prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: 'SENT', sentAt: new Date(), attempts: d.attempts + 1, lastError: null } });
      } catch (err) {
        const message = (err as Error).message.slice(0, 300);
        logger.warn({ deliveryId: d.id, err: message }, 'email delivery failed');
        await prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: 'FAILED', attempts: d.attempts + 1, lastError: message } });
      }
    }
  }
}
