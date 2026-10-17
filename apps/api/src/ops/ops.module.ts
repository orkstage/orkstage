// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from '@nestjs/common';
import { AlertRulesController } from './alert-rules.controller.js';
import { IncidentsController } from './incidents.controller.js';
import { OpsController } from './ops.controller.js';

@Module({ controllers: [OpsController, IncidentsController, AlertRulesController] })
export class OpsModule {}
