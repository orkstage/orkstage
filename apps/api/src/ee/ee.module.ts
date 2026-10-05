// SPDX-License-Identifier: LicenseRef-OrkStage-Enterprise
// Copyright OrkStage. Licensed under the OrkStage Enterprise License (see ./LICENSE).
import { Module } from '@nestjs/common';
import { AuditExportController } from './audit-export.controller.js';

/**
 * OrkStage Enterprise modules. Always compiled and shipped; every route is gated by
 * @RequiresFeature and answers 402 without a license that covers it (docs/OPEN_CORE.md).
 * Core code never imports from ee/ — only the composition root (app.module) registers it.
 */
@Module({ controllers: [AuditExportController] })
export class EnterpriseModule {}
