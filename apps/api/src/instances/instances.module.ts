import { Module } from '@nestjs/common';
import { DeploymentsController } from '../deployments/deployments.controller.js';
import { LauncherService } from '../deployments/launcher.service.js';
import { CompileService } from './compile.service.js';
import { InstancesController } from './instances.controller.js';

@Module({
  controllers: [InstancesController, DeploymentsController],
  providers: [CompileService, LauncherService],
})
export class InstancesModule {}
