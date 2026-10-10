import { Module } from '@nestjs/common';
import { CloudController } from './cloud.controller.js';
import { FeatureFlagsController } from './feature-flags.controller.js';
import { MarketplaceController } from './marketplace.controller.js';
import { TemplateValidationService } from './template-validation.service.js';
import { TemplatesController } from './templates.controller.js';
import { TenantsController } from './tenants.controller.js';

@Module({ controllers: [TenantsController, TemplatesController, CloudController, FeatureFlagsController, MarketplaceController], providers: [TemplateValidationService] })
export class CatalogModule {}
