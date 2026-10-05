import { Module } from '@nestjs/common';
import { CloudController } from './cloud.controller.js';
import { TemplateValidationService } from './template-validation.service.js';
import { TemplatesController } from './templates.controller.js';
import { TenantsController } from './tenants.controller.js';

@Module({ controllers: [TenantsController, TemplatesController, CloudController], providers: [TemplateValidationService] })
export class CatalogModule {}
