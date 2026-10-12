// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from '@nestjs/common';
import { DeploymentsController } from '../deployments/deployments.controller.js';
import { LauncherService } from '../deployments/launcher.service.js';
import { CompileService } from './compile.service.js';
import { InstancesController } from './instances.controller.js';
import { TriggersController } from './triggers.controller.js';

@Module({
  controllers: [InstancesController, TriggersController, DeploymentsController],
  providers: [CompileService, LauncherService],
})
export class InstancesModule {}
