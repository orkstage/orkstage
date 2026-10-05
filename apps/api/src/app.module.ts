import { loggerOptions, type PlatformConfig } from '@co/runtime';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { IncomingMessage } from 'node:http';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { AuthGuard, CsrfGuard } from './common/auth.js';
import { CommonModule } from './common/common.module.js';
import { ErrorFilter } from './common/errors.js';
import { CONFIG, InfraModule } from './infra/infra.module.js';
import { InstancesModule } from './instances/instances.module.js';
import { OpsModule } from './ops/ops.module.js';

@Module({
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
    // Global ceiling per client; expensive routes declare stricter limits (spec §73).
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 600 }]),
    AuthModule,
    CatalogModule,
    InstancesModule,
    OpsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
