import { publishApplicationVersionSchema, validateSourceSchema } from '@co/contracts';
import type { PrismaClient } from '@co/database';
import type { PlanCode } from '@co/domain';
import { Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, Scope } from '../common/auth.js';
import { conflict, notFound } from '../common/errors.js';
import { ApiZodBody, ZodBody } from '../common/validation.js';
import { PRISMA } from '../infra/infra.module.js';
import { TemplateValidationService } from '../catalog/template-validation.service.js';
import type { RequestPrincipal } from '../types.js';

/** Endpoints designed for CI/CD and the `ork` CLI (docs/specs/integration-api.md). */
@ApiTags('ci')
@Controller()
export class CiController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly validation: TemplateValidationService,
    private readonly audit: AuditService,
  ) {}

  /** Stateless validation of a template source (no template id needed). */
  @Scope('templates:read')
  @Post('templates/validate')
  @HttpCode(200)
  @ApiZodBody(validateSourceSchema)
  async validate(@CurrentPrincipal() p: RequestPrincipal, @ZodBody(validateSourceSchema) body: z.infer<typeof validateSourceSchema>) {
    authorize(p, 'read', 'Template');
    return this.validation.validate(body.source, body.planCode ? [body.planCode as PlanCode] : undefined);
  }

  /** CI publishes a new immutable image version of a catalog application. */
  @Scope('applications:write')
  @Post('applications/:name/versions')
  @ApiZodBody(publishApplicationVersionSchema)
  async publishVersion(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('name') name: string,
    @ZodBody(publishApplicationVersionSchema) body: z.infer<typeof publishApplicationVersionSchema>,
    @CorrelationId() correlationId: string,
  ) {
    authorize(p, 'update', 'Application');
    const app = await this.prisma.application.findUnique({ where: { name } });
    if (!app) throw notFound('Application');
    const existing = await this.prisma.applicationVersion.findUnique({ where: { applicationId_version: { applicationId: app.id, version: body.version } } });
    if (existing) {
      // Re-publishing the same version is idempotent only when the digest is identical.
      if (existing.digest === body.digest) return { ...existing, createdAt: existing.createdAt.toISOString(), idempotent: true };
      throw conflict('VERSION_EXISTS', `Version ${body.version} already exists with a different digest. Versions are immutable.`);
    }
    const v = await this.prisma.applicationVersion.create({
      data: { applicationId: app.id, version: body.version, imageUri: body.imageUri, digest: body.digest, architectures: body.architectures },
    });
    await this.audit.record({ principal: p, resourceType: 'ApplicationVersion', resourceId: v.id, action: 'PUBLISH', correlationId, changes: { application: name, version: v.version, digest: v.digest } });
    return { ...v, createdAt: v.createdAt.toISOString(), idempotent: false };
  }
}
