// SPDX-License-Identifier: AGPL-3.0-only
import { Licensing, type EnterpriseFeature } from '@orkstage/licensing';
import type { PlatformConfig } from '@orkstage/runtime';
import { Controller, Get, Global, Inject, Injectable, Logger, Module, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiTags } from '@nestjs/swagger';
import { Scope } from '../common/auth.js';
import { AppError } from '../common/errors.js';
import { CONFIG } from '../infra/infra.module.js';

export const LICENSING = Symbol('LICENSING');
const FEATURE = 'co:enterpriseFeature';

/** Marks a route as an Enterprise feature; without a license covering it the API answers 402. */
export const RequiresFeature = (feature: EnterpriseFeature) => SetMetadata(FEATURE, feature);

@Injectable()
export class EnterpriseFeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(LICENSING) private readonly licensing: Licensing,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const feature = this.reflector.getAllAndOverride<EnterpriseFeature | undefined>(FEATURE, [ctx.getHandler(), ctx.getClass()]);
    if (!feature || this.licensing.has(feature)) return true;
    throw new AppError(402, 'ENTERPRISE_REQUIRED', `This feature (${feature}) is part of OrkStage Enterprise.`, { feature, edition: this.licensing.state.edition });
  }
}

/** Edition and licensed features. Never returns the key itself. */
@ApiTags('license')
@Controller('license')
export class LicenseController {
  constructor(@Inject(LICENSING) private readonly licensing: Licensing) {}

  @Scope('*')
  @Get()
  get() {
    const s = this.licensing.state;
    return { edition: s.edition, status: s.status, customer: s.customer ?? null, features: s.features, expiresAt: s.expiresAt ?? null, message: s.message };
  }
}

@Global()
@Module({
  controllers: [LicenseController],
  providers: [
    {
      provide: LICENSING,
      inject: [CONFIG],
      useFactory: (config: PlatformConfig) => {
        const licensing = new Licensing(config.ORKSTAGE_LICENSE_KEY);
        new Logger('Licensing').log(licensing.state.message);
        return licensing;
      },
    },
    EnterpriseFeatureGuard,
  ],
  exports: [LICENSING, EnterpriseFeatureGuard],
})
export class LicensingModule {}
