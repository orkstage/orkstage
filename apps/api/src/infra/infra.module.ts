import { QUEUES, type DeploymentJob, type NotificationJob } from '@co/contracts';
import { createPrismaClient, type PrismaClient } from '@co/database';
import {
  createAdapterRegistry,
  createRedis,
  EnvSecretResolver,
  loadConfig,
  SecretBox,
  type PlatformConfig,
} from '@co/runtime';
import type { AdapterRegistry } from '@co/cloud-core';
import type { MockAdapter } from '@co/cloud-mock';
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export const CONFIG = Symbol('CONFIG');
export const PRISMA = Symbol('PRISMA');
export const REDIS = Symbol('REDIS');
export const SECRET_BOX = Symbol('SECRET_BOX');

/** Cloud adapters, plus the mock adapter for simulation controls. */
@Injectable()
export class Adapters {
  readonly registry: AdapterRegistry;
  readonly mock: MockAdapter;
  constructor(@Inject(REDIS) redis: Redis, @Inject(CONFIG) config: PlatformConfig) {
    const { registry, mock } = createAdapterRegistry({ redis, secrets: new EnvSecretResolver(), awsEmulatorEndpoint: config.AWS_EMULATOR_ENDPOINT });
    this.registry = registry;
    this.mock = mock;
  }
}

/** Job producers. Payloads carry ids; the worker reloads state from the database. */
@Injectable()
export class Queues implements OnApplicationShutdown {
  readonly deployments: Queue<DeploymentJob>;
  readonly notifications: Queue<NotificationJob>;

  constructor(@Inject(REDIS) redis: Redis) {
    const connection = redis.duplicate();
    this.deployments = new Queue<DeploymentJob>(QUEUES.deployments, { connection });
    this.notifications = new Queue<NotificationJob>(QUEUES.notifications, { connection });
  }

  /** jobId = deployment id (+ phase) so duplicate enqueues collapse into one job. */
  async enqueueDeployment(deploymentId: string, phase = 'run') {
    await this.deployments.add('deployment', { deploymentId }, {
      jobId: `${deploymentId}--${phase}`,
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  async notify(job: NotificationJob) {
    await this.notifications.add('notify', job, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  async onApplicationShutdown() {
    await Promise.all([this.deployments.close(), this.notifications.close()]);
  }
}

@Injectable()
export class Lifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}
  async onApplicationShutdown() {
    await this.prisma.$disconnect();
    this.redis.disconnect();
  }
}

@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: (): PlatformConfig => loadConfig() },
    { provide: PRISMA, useFactory: (config: PlatformConfig) => createPrismaClient(config.DATABASE_URL), inject: [CONFIG] },
    { provide: REDIS, useFactory: (config: PlatformConfig) => createRedis(config.REDIS_URL), inject: [CONFIG] },
    { provide: SECRET_BOX, useFactory: (config: PlatformConfig) => new SecretBox(config.ENCRYPTION_KEY, config.SESSION_SECRET), inject: [CONFIG] },
    Adapters,
    Queues,
    Lifecycle,
  ],
  exports: [CONFIG, PRISMA, REDIS, SECRET_BOX, Adapters, Queues],
})
export class InfraModule {}
