import { QUEUES, type DeploymentJob, type NotificationJob } from '@co/contracts';
import { createPrismaClient } from '@co/database';
import { createAdapterRegistry, createLogger, createRedis, createSecretResolver, createTofuRunner, loadConfig, loadDotEnv } from '@co/runtime';
import { DelayedError, Queue, Worker } from 'bullmq';
import type { WorkerContext } from './context.js';
import { DriftDetector } from './drift.js';
import { HealthMonitor } from './health.js';
import { Notifier } from './notifier.js';
import { DeploymentRunner, RetryLater } from './runner.js';
import { TargetSlots } from './slots.js';
import { WebhookDispatcher } from './webhooks.js';

const SLOT_WAIT_MS = 5000;

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const logger = createLogger('provisioning-worker', config.LOG_LEVEL);
  const redis = createRedis(config.REDIS_URL);
  const prisma = createPrismaClient(config.DATABASE_URL);
  // Only the worker provisions: it alone gets an OpenTofu runner (the API validates targets only).
  const tofu = createTofuRunner(config);
  const { registry } = createAdapterRegistry({ redis, secrets: createSecretResolver({ awsRegion: config.SECRETS_AWS_REGION, awsEndpoint: config.SECRETS_AWS_ENDPOINT }), runner: tofu, awsEmulatorEndpoint: config.AWS_EMULATOR_ENDPOINT });
  const notifications = new Queue<NotificationJob>(QUEUES.notifications, { connection: redis.duplicate() });
  const ctx: WorkerContext = { config, prisma, redis, registry, logger, notifications };

  const runner = new DeploymentRunner(ctx, new TargetSlots(redis));
  const monitor = new HealthMonitor(ctx);
  const notifier = new Notifier(ctx);

  const deployments = new Worker<DeploymentJob>(
    QUEUES.deployments,
    async (job, token) => {
      try {
        await runner.run(job.data.deploymentId);
      } catch (err) {
        if (err instanceof RetryLater) {
          await job.moveToDelayed(Date.now() + SLOT_WAIT_MS, token);
          throw new DelayedError();
        }
        throw err;
      }
    },
    // A stalled job (crashed worker) is picked up again; the runner resumes from persisted steps.
    { connection: redis.duplicate(), concurrency: config.WORKER_CONCURRENCY, maxStalledCount: 3, lockDuration: 60_000 },
  );

  const webhooks = new WebhookDispatcher(ctx);
  const notify = new Worker<NotificationJob>(
    QUEUES.notifications,
    async (job) => {
      // Webhooks first: they are idempotent per job id, so a retry after a mail failure is safe.
      if ((await webhooks.enqueue(String(job.id), job.data)) > 0) await webhooks.deliverDue();
      await notifier.handle(job.data);
    },
    { connection: redis.duplicate(), concurrency: 4 },
  );

  const healthQueue = new Queue(QUEUES.health, { connection: redis.duplicate() });
  await healthQueue.upsertJobScheduler('health-tick', { every: config.HEALTH_CHECK_INTERVAL_SECONDS * 1000 }, { name: 'tick' });
  const health = new Worker(
    QUEUES.health,
    async () => {
      await monitor.tick();
      await notifier.deliverPending();
      await webhooks.deliverDue();
    },
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
    async () => {
      const result = await detector.scan();
      logger.info(result, 'drift scan finished');
      return result;
    },
    { connection: redis.duplicate(), concurrency: 1, lockDuration: 120_000 },
  );

  for (const [name, w] of [['deployments', deployments], ['notifications', notify], ['health', health], ['drift', drift]] as const) {
    w.on('failed', (job, err) => logger.error({ queue: name, jobId: job?.id, err: err.message }, 'job failed'));
    w.on('error', (err) => logger.error({ queue: name, err: err.message }, 'worker error'));
  }
  logger.info({ concurrency: config.WORKER_CONCURRENCY, healthIntervalSeconds: config.HEALTH_CHECK_INTERVAL_SECONDS, driftIntervalMinutes: config.DRIFT_CHECK_INTERVAL_MINUTES }, 'worker started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down: finishing in-flight jobs');
    await Promise.all([deployments.close(), notify.close(), health.close(), drift.close()]);
    await Promise.all([healthQueue.close(), driftQueue.close(), notifications.close()]);
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
