// SPDX-License-Identifier: AGPL-3.0-only
import { loggerOptions, RedisRateLimitStorage, type PlatformConfig } from '@orkstage/runtime';
import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import type { IncomingMessage } from 'node:http';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { AuthGuard, CsrfGuard } from './common/auth.js';
import { CommonModule } from './common/common.module.js';
import { ErrorFilter } from './common/errors.js';
import { ClientThrottlerGuard } from './common/throttler.guard.js';
import { CONFIG, InfraModule, REDIS } from './infra/infra.module.js';
import { InstancesModule } from './instances/instances.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { LicensingModule } from './licensing/licensing.module.js';
import { OpsModule } from './ops/ops.module.js';

/**
 * The application. `register` adds the Enterprise module when this build has one (see
 * enterprise.ts); its routes are gated per feature by the license key.
 */
@Module({})
export class AppModule {
  static register(enterprise?: Type): DynamicModule {
    return {
      module: AppModule,
      imports: [
        InfraModule,
        CommonModule,
        LoggerModule.forRootAsync({
          inject: [CONFIG],
          useFactory: (config: PlatformConfig) => ({
            pinoHttp: {
              ...loggerOptions('api', config.LOG_LEVEL),
              customProps: (req: IncomingMessage) => ({ correlationId: (req as IncomingMessage & { correlationId?: string }).correlationId }),
              autoLogging: { ignore: (req: IncomingMessage) => Boolean(req.url?.includes('/healthz')) },
              ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
            },
          }),
        }),
        // Global ceiling per client; expensive routes declare stricter limits (spec §73). Counters live
        // in Redis so the limits hold across every API instance (spec §49).
        ThrottlerModule.forRootAsync({
          inject: [REDIS],
          useFactory: (redis: Redis) => ({
            throttlers: [{ name: 'default', ttl: 60_000, limit: 600 }],
            storage: new RedisRateLimitStorage(redis),
          }),
        }),
        AuthModule,
        CatalogModule,
        InstancesModule,
        OpsModule,
        IntegrationsModule,
        LicensingModule,
        ...(enterprise ? [enterprise] : []),
      ],
      providers: [
        { provide: APP_GUARD, useClass: ClientThrottlerGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}
