import { Module } from '@nestjs/common';
import { IncidentsController } from './incidents.controller.js';
import { OpsController } from './ops.controller.js';

@Module({ controllers: [OpsController, IncidentsController] })
export class OpsModule {}
