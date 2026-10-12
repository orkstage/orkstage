// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from '@nestjs/common';
import { TemplateValidationService } from '../catalog/template-validation.service.js';
import { ApiKeysController } from './api-keys.controller.js';
import { CiController } from './ci.controller.js';
import { ImportsController } from './imports.controller.js';
import { WebhooksController } from './webhooks.controller.js';

@Module({
  controllers: [ApiKeysController, WebhooksController, CiController, ImportsController],
  providers: [TemplateValidationService],
})
export class IntegrationsModule {}
