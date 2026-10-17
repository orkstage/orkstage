// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { IdentityLinker } from './identity-linker.js';
import { OidcService } from './oidc.service.js';
import { SessionService } from './session.service.js';

@Module({ controllers: [AuthController], providers: [OidcService, SessionService, IdentityLinker] })
export class AuthModule {}
