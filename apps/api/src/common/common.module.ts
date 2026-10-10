import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { FeatureFlagsService } from './feature-flags.service.js';

@Global()
@Module({ providers: [AuditService, FeatureFlagsService], exports: [AuditService, FeatureFlagsService] })
export class CommonModule {}
