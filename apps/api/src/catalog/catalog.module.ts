import { Module } from '@nestjs/common';
import { CloudController } from './cloud.controller.js';
import { TemplatesController } from './templates.controller.js';
import { TenantsController } from './tenants.controller.js';

@Module({ controllers: [TenantsController, TemplatesController, CloudController] })
export class CatalogModule {}
