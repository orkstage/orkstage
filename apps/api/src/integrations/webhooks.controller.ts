import { createWebhookSchema, updateWebhookSchema, type WebhookDeliveryDto, type WebhookDto } from '@orkstage/contracts';
import type { PrismaClient, WebhookDelivery, WebhookEndpoint } from '@orkstage/database';
import { assertSafeWebhookUrl, randomToken, sendWebhook, type PlatformConfig, type SecretBox, UnsafeWebhookUrlError } from '@orkstage/runtime';
import { Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, isPlatformStaff, Scope } from '../common/auth.js';
import { notFound, unprocessable } from '../common/errors.js';
import { iso } from '../common/pagination.js';
import { ApiZodBody, ZodBody } from '../common/validation.js';
import { CONFIG, PRISMA, SECRET_BOX } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';

function toDto(w: WebhookEndpoint): WebhookDto {
  return {
    id: w.id,
    tenantId: w.tenantId,
    url: w.url,
    description: w.description,
    events: w.events,
    enabled: w.enabled,
    consecutiveFailures: w.consecutiveFailures,
    disabledReason: w.disabledReason,
    createdAt: w.createdAt.toISOString(),
  };
}

function toDeliveryDto(d: WebhookDelivery): WebhookDeliveryDto {
  return {
    id: d.id,
    event: d.event,
    status: d.status as WebhookDeliveryDto['status'],
    attempts: d.attempts,
    responseStatus: d.responseStatus,
    lastError: d.lastError,
    nextAttemptAt: d.status === 'PENDING' || d.status === 'RETRYING' ? d.nextAttemptAt.toISOString() : null,
    deliveredAt: iso(d.deliveredAt),
    createdAt: d.createdAt.toISOString(),
  };
}

/** Outbound webhooks (docs/specs/integration-api.md). Secrets are shown once and stored encrypted. */
@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
    @Inject(CONFIG) private readonly config: PlatformConfig,
    private readonly audit: AuditService,
  ) {}

  @Scope('webhooks:manage')
  @Get()
  async list(@CurrentPrincipal() p: RequestPrincipal, @Query('tenantId') tenantId?: string): Promise<WebhookDto[]> {
    if (tenantId) authorize(p, 'read', 'Webhook', { tenantId });
    const adminTenants = p.memberships.filter((m) => ['CustomerOwner', 'CustomerAdmin'].includes(m.role)).map((m) => m.tenantId);
    const rows = await this.prisma.webhookEndpoint.findMany({
      where: tenantId ? { tenantId } : isPlatformStaff(p) ? {} : { tenantId: { in: adminTenants } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toDto);
  }

  @Scope('webhooks:manage')
  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiZodBody(createWebhookSchema)
  async create(
    @CurrentPrincipal() p: RequestPrincipal,
    @ZodBody(createWebhookSchema) body: z.infer<typeof createWebhookSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<{ webhook: WebhookDto; secret: string }> {
    authorize(p, 'create', 'Webhook', { tenantId: body.tenantId ?? null });
    await this.assertUrl(body.url);
    const organizationId = await this.organizationOf(body.tenantId);
    const secret = `whsec_${randomToken(32)}`;
    const webhook = await this.prisma.webhookEndpoint.create({
      data: {
        organizationId,
        tenantId: body.tenantId ?? null,
        url: body.url,
        description: body.description,
        events: body.events,
        secretEncrypted: this.box.seal(secret),
        createdById: p.userId,
      },
    });
    await this.audit.record({ principal: p, tenantId: webhook.tenantId, resourceType: 'Webhook', resourceId: webhook.id, action: 'CREATE', correlationId, changes: { url: webhook.url, events: webhook.events } });
    return { webhook: toDto(webhook), secret };
  }

  @Scope('webhooks:manage')
  @Patch(':id')
  @ApiZodBody(updateWebhookSchema)
  async update(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(updateWebhookSchema) body: z.infer<typeof updateWebhookSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<WebhookDto> {
    const w = await this.load(p, id, 'update');
    if (body.url) await this.assertUrl(body.url);
    const updated = await this.prisma.webhookEndpoint.update({
      where: { id },
      data: {
        ...body,
        // Re-enabling clears the automatic disable state.
        ...(body.enabled ? { consecutiveFailures: 0, disabledReason: null } : {}),
      },
    });
    await this.audit.record({ principal: p, tenantId: w.tenantId, resourceType: 'Webhook', resourceId: id, action: 'UPDATE', correlationId, changes: body });
    return toDto(updated);
  }

  @Scope('webhooks:manage')
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string, @CorrelationId() correlationId: string) {
    const w = await this.load(p, id, 'delete');
    await this.prisma.webhookEndpoint.delete({ where: { id } });
    await this.audit.record({ principal: p, tenantId: w.tenantId, resourceType: 'Webhook', resourceId: id, action: 'DELETE', correlationId, changes: { url: w.url } });
  }

  @Scope('webhooks:manage')
  @Post(':id/rotate-secret')
  @HttpCode(200)
  async rotate(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string, @CorrelationId() correlationId: string) {
    const w = await this.load(p, id, 'update');
    const secret = `whsec_${randomToken(32)}`;
    await this.prisma.webhookEndpoint.update({ where: { id }, data: { secretEncrypted: this.box.seal(secret) } });
    await this.audit.record({ principal: p, tenantId: w.tenantId, resourceType: 'Webhook', resourceId: id, action: 'ROTATE_SECRET', correlationId });
    return { secret };
  }

  /** Sends a `ping` immediately so the sender sees the result. */
  @Scope('webhooks:manage')
  @Post(':id/test')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async test(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string): Promise<WebhookDeliveryDto> {
    const w = await this.load(p, id, 'update');
    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        endpointId: id,
        event: 'ping',
        payload: { type: 'ping', createdAt: new Date().toISOString(), tenantId: w.tenantId, data: { message: 'OrkStage webhook test' } },
        status: 'PENDING',
      },
    });
    const result = await sendWebhook({
      url: w.url,
      secret: this.box.open(w.secretEncrypted),
      event: 'ping',
      deliveryId: delivery.id,
      payload: { id: delivery.id, ...(delivery.payload as object) },
      allowPrivate: this.config.WEBHOOK_ALLOW_PRIVATE,
    });
    const done = await this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: result.ok ? 'SUCCEEDED' : 'FAILED',
        attempts: 1,
        responseStatus: result.status ?? null,
        lastError: result.error ?? null,
        deliveredAt: result.ok ? new Date() : null,
      },
    });
    return toDeliveryDto(done);
  }

  @Scope('webhooks:manage')
  @Get(':id/deliveries')
  async deliveries(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string): Promise<WebhookDeliveryDto[]> {
    await this.load(p, id, 'read');
    const rows = await this.prisma.webhookDelivery.findMany({ where: { endpointId: id }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map(toDeliveryDto);
  }

  @Scope('webhooks:manage')
  @Post(':id/deliveries/:deliveryId/redeliver')
  @HttpCode(202)
  async redeliver(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
  ): Promise<WebhookDeliveryDto> {
    await this.load(p, id, 'update');
    const original = await this.prisma.webhookDelivery.findFirst({ where: { id: deliveryId, endpointId: id } });
    if (!original) throw notFound('Delivery');
    // A new delivery (new id) with the same payload; the worker sends it on its next pass.
    const copy = await this.prisma.webhookDelivery.create({ data: { endpointId: id, event: original.event, payload: original.payload as object } });
    return toDeliveryDto(copy);
  }

  private async load(p: RequestPrincipal, id: string, action: 'read' | 'update' | 'delete') {
    const w = await this.prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!w) throw notFound('Webhook');
    if (!isPlatformStaff(p) && !p.memberships.some((m) => m.tenantId === w.tenantId)) throw notFound('Webhook');
    authorize(p, action, 'Webhook', { tenantId: w.tenantId });
    return w;
  }

  private async assertUrl(url: string) {
    try {
      await assertSafeWebhookUrl(url, this.config.WEBHOOK_ALLOW_PRIVATE);
    } catch (err) {
      if (err instanceof UnsafeWebhookUrlError) throw unprocessable('UNSAFE_WEBHOOK_URL', err.message);
      throw unprocessable('UNSAFE_WEBHOOK_URL', 'The webhook host could not be resolved.');
    }
  }

  private async organizationOf(tenantId?: string): Promise<string> {
    const id = tenantId
      ? (await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { organizationId: true } }))?.organizationId
      : (await this.prisma.organization.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } }))?.id;
    if (!id) throw notFound(tenantId ? 'Tenant' : 'Organization');
    return id;
  }
}
