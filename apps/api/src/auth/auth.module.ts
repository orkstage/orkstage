import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { OidcService } from './oidc.service.js';
import { SessionService } from './session.service.js';

@Module({ controllers: [AuthController], providers: [OidcService, SessionService] })
export class AuthModule {}
