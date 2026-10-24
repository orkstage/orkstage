// SPDX-License-Identifier: AGPL-3.0-only
import { QUEUES, type DeploymentJob, type InvitationEmailJob, type NotificationJob, type StatusEmailJob, type TriggerJob } from '@orkstage/contracts';
import { createPrismaClient } from '@orkstage/database';
import {
  createAdapterRegistry,
  createLogger,
  createRedis,
  createSecretResolver,
  createTofuRunner,
  loadConfig,
  loadDotEnv,
  platformMetrics,
  SecretBox,
  traceJob,
} from '@orkstage/runtime';
import { stopTelemetry } from '@orkstage/runtime/telemetry';
import { DelayedError, Queue, Worker } from 'bullmq';
import type { WorkerContext } from './context.js';
import { DriftDetector } from './drift.js';
import { HealthMonitor } from './health.js';
import { Housekeeping } from './housekeeping.js';
import { ReleaseWatcher } from './releases.js';
import { Notifier } from './notifier.js';
import { DeploymentRunner, RetryLater } from './runner.js';
import { TargetSlots } from './slots.js';
import { TriggerRunner } from './triggers.js';
import { WebhookDispatcher } from './webhooks.js';

const SLOT_WAIT_MS = 5000;

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const logger = createLogger('orkstage-worker', config.LOG_LEVEL);
  const redis = createRedis(config.REDIS_URL);
  const prisma = createPrismaClient(config.DATABASE_URL);
  // Only the worker provisions: it alone gets an OpenTofu runner (the API validates targets only).
  const tofu = createTofuRunner(config);
  const box = new SecretBox(config.ENCRYPTION_KEY, config.SESSION_SECRET);
  const { registry } = createAdapterRegistry({
    redis,
    secrets: createSecretResolver({ awsRegion: config.SECRETS_AWS_REGION, awsEndpoint: config.SECRETS_AWS_ENDPOINT }),
    deriveSecret: (purpose) => box.derive(purpose),
    runner: tofu,
    awsEmulatorEndpoint: config.AWS_EMULATOR_ENDPOINT,
    awsSessionSeconds: config.AWS_ROLE_SESSION_MINUTES * 60,
  });
  const notifications = new Queue<NotificationJob>(QUEUES.notifications, { connection: redis.duplicate() });
  const ctx: WorkerContext = { config, prisma, redis, registry, logger, notifications };

  const runner = new DeploymentRunner(ctx, new TargetSlots(redis));
  const triggerQueue = new Queue<TriggerJob>(QUEUES.triggers, { connection: redis.duplicate() });
  const triggerRunner = new TriggerRunner(ctx, triggerQueue);
  // Scheduled triggers live in Redis as job schedulers. Register them again at startup, so after a
  // Redis loss they do not wait for each instance's next deployment (syncSchedules is idempotent).
  for (const { id } of await prisma.instance.findMany({ where: { status: { not: 'DESTROYED' } }, select: { id: true } })) {
    await triggerRunner.syncSchedules(id).catch((err: unknown) => logger.warn({ instanceId: id, err: (err as Error).message }, 'trigger schedules not synced'));
  }
  const monitor = new HealthMonitor(ctx);
  const emailQueue = new Queue<StatusEmailJob>(QUEUES.emails, { connection: redis.duplicate() });
  const notifier = new Notifier(ctx, emailQueue);

  const deploymentQueue = new Queue<DeploymentJob>(QUEUES.deployments, { connection: redis.duplicate() });
  const releases = new ReleaseWatcher(ctx, deploymentQueue);

  const deployments = new Worker<DeploymentJob>(
    QUEUES.deployments,
    async (job, token) =>
      traceJob(QUEUES.deployments, job, { 'deployment.id': job.data.deploymentId }, async () => {
        try {
          await runner.run(job.data.deploymentId);
          const done = await prisma.deployment.findUnique({
            where: { id: job.data.deploymentId },
            select: { instanceId: true, status: true, kind: true, queuedAt: true, finishedAt: true },
          });
          if (done?.finishedAt) platformMetrics.deployment(done.kind, done.status, done.finishedAt.getTime() - done.queuedAt.getTime());
          // Scheduled triggers follow the template version that is now live (or stop on destroy).
          if (done?.status === 'SUCCEEDED') await triggerRunner.syncSchedules(done.instanceId);
          // A watched release that failed its health checks rolls back like one failing its bake period.
          if (done?.status === 'FAILED' || done?.status === 'PARTIALLY_FAILED') await releases.afterFailure(job.data.deploymentId);
        } catch (err) {
          if (err instanceof RetryLater) {
            await job.moveToDelayed(Date.now() + SLOT_WAIT_MS, token);
            throw new DelayedError();
          }
          throw err;
        }
      }),
    // A stalled job (crashed worker) is picked up again; the runner resumes from persisted steps.
    { connection: redis.duplicate(), concurrency: config.WORKER_CONCURRENCY, maxStalledCount: 3, lockDuration: 60_000 },
  );

  const webhooks = new WebhookDispatcher(ctx);
  const notify = new Worker<NotificationJob>(
    QUEUES.notifications,
    async (job) =>
      traceJob(QUEUES.notifications, job, { 'tenant.id': job.data.tenantId, 'notification.event': job.data.event }, async () => {
        // Webhooks first: they are idempotent per job id, so a retry after a mail failure is safe.
        if ((await webhooks.enqueue(String(job.id), job.data)) > 0) await webhooks.deliverDue();
        await notifier.handle(job.data);
      }),
    { connection: redis.duplicate(), concurrency: 4 },
  );

  const housekeeping = new Housekeeping(ctx, deploymentQueue, (id, message) => runner.abandon(id, message));
  const healthQueue = new Queue(QUEUES.health, { connection: redis.duplicate() });
  await healthQueue.upsertJobScheduler('health-tick', { every: config.HEALTH_CHECK_INTERVAL_SECONDS * 1000 }, { name: 'tick' });
  const health = new Worker(
    QUEUES.health,
    async (job) =>
      traceJob(QUEUES.health, job, {}, async () => {
        await monitor.tick();
        // After the tick: incidents and health counts are current when bake periods are judged.
        await releases.run();
        await housekeeping.run();
        await notifier.deliverPending();
        await webhooks.deliverDue();
      }),
    { connection: redis.duplicate(), concurrency: 1 },
  );

  // Drift scans: one OpenTofu plan per applied resource on real providers, on their own queue so a
  // long scan never delays health checks. The scheduler runs each scan once across all workers.
  const driftQueue = new Queue(QUEUES.drift, { connection: redis.duplicate() });
  if (config.DRIFT_CHECK_INTERVAL_MINUTES > 0) {
    await driftQueue.upsertJobScheduler('drift-scan', { every: config.DRIFT_CHECK_INTERVAL_MINUTES * 60_000 }, { name: 'scan' });
  } else {
    await driftQueue.removeJobScheduler('drift-scan');
  }
  const detector = new DriftDetector(ctx);
  const drift = new Worker(
    QUEUES.drift,
    async (job) =>
      traceJob(QUEUES.drift, job, {}, async () => {
        const result = await detector.scan();
        logger.info(result, 'drift scan finished');
        return result;
      }),
    { connection: redis.duplicate(), concurrency: 1, lockDuration: 120_000 },
  );

  const emails = new Worker<InvitationEmailJob | StatusEmailJob>(
    QUEUES.emails,
    async (job) => traceJob(QUEUES.emails, job, {}, () => (job.data.kind === 'status' ? notifier.sendStatusEmail(job.data) : notifier.sendInvitation(job.data))),
    { connection: redis.duplicate(), concurrency: 2 },
  );

  // Trigger runs: provider actions are short API calls (they start work, they do not wait for it).
  const triggers = new Worker<TriggerJob>(
    QUEUES.triggers,
    async (job) => traceJob(QUEUES.triggers, job, 'runId' in job.data ? { 'trigger.run.id': job.data.runId } : { 'instance.id': job.data.instanceId }, () => triggerRunner.handle(job.data)),
    { connection: redis.duplicate(), concurrency: 4 },
  );

  // Queue depth, read only when metrics are exported (no-op without OpenTelemetry).
  const depthQueues = [deploymentQueue, notifications, triggerQueue, healthQueue, driftQueue];
  platformMetrics.observeQueues(async () => {
    const out: { queue: string; state: string; count: number }[] = [];
    for (const q of depthQueues) {
      const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
      for (const [state, count] of Object.entries(counts)) out.push({ queue: q.name, state, count });
    }
    return out;
  });

  for (const [name, w] of [['deployments', deployments], ['notifications', notify], ['health', health], ['drift', drift], ['triggers', triggers], ['emails', emails]] as const) {
    w.on('failed', (job, err) => logger.error({ queue: name, jobId: job?.id, err: err.message }, 'job failed'));
    w.on('error', (err) => logger.error({ queue: name, err: err.message }, 'worker error'));
  }
  logger.info({ concurrency: config.WORKER_CONCURRENCY, healthIntervalSeconds: config.HEALTH_CHECK_INTERVAL_SECONDS, driftIntervalMinutes: config.DRIFT_CHECK_INTERVAL_MINUTES }, 'worker started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down: finishing in-flight jobs');
    await Promise.all([deployments.close(), notify.close(), health.close(), drift.close(), triggers.close(), emails.close()]);
    await Promise.all([healthQueue.close(), driftQueue.close(), notifications.close(), triggerQueue.close(), deploymentQueue.close(), emailQueue.close()]);
    await prisma.$disconnect();
    redis.disconnect();
    await stopTelemetry();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
