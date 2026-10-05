import { listQuerySchema, type DeploymentDto, type DeploymentEventDto, type ListQuery } from '@co/contracts';
import type { PrismaClient } from '@co/database';
import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, tenantScope } from '../common/auth.js';
import { conflict, notFound } from '../common/errors.js';
import { iso, page } from '../common/pagination.js';
import { ZodQuery } from '../common/validation.js';
import { PRISMA, Queues } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';
import { LauncherService, toDeploymentSummary } from './launcher.service.js';

@ApiTags('deployments')
@Controller('deployments')
export class DeploymentsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly launcher: LauncherService,
    private readonly queues: Queues,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentPrincipal() p: RequestPrincipal, @ZodQuery(listQuerySchema) q: ListQuery) {
    const rows = await this.prisma.deployment.findMany({
      where: {
        ...tenantScope(p),
        ...(q.tenantId ? { tenantId: q.tenantId } : {}),
        ...(q.instanceId ? { instanceId: q.instanceId } : {}),
        ...(q.status ? { status: q.status as never } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    return page(rows, q.limit, toDeploymentSummary);
  }

  @Get(':id')
  async get(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string): Promise<DeploymentDto> {
    const d = await this.load(p, id);
    const [steps, instance] = await Promise.all([
      this.prisma.deploymentStep.findMany({ where: { deploymentId: id }, orderBy: { position: 'asc' } }),
      this.prisma.instance.findUniqueOrThrow({ where: { id: d.instanceId }, select: { name: true } }),
    ]);
    return {
      ...toDeploymentSummary(d),
      instanceName: instance.name,
      approvalRequired: d.approvalRequired,
      steps: steps.map((s) => ({
        key: s.key,
        kind: s.kind as 'PHASE' | 'RESOURCE',
        name: s.name,
        position: s.position,
        status: s.status,
        attempt: s.attempt,
        provider: s.provider,
        region: s.region,
        errorClass: s.errorClass,
        errorMessage: s.errorMessage,
        startedAt: iso(s.startedAt),
        finishedAt: iso(s.finishedAt),
      })),
      plan: (d.plan ?? null) as DeploymentDto['plan'],
      cost: (d.cost ?? null) as DeploymentDto['cost'],
      outputs: (d.outputs ?? null) as DeploymentDto['outputs'],
    };
  }

  /** Incremental event log for live progress; poll with the last seen id. */
  @Get(':id/events')
  async events(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string, @Query('after') after?: string): Promise<DeploymentEventDto[]> {
    await this.load(p, id);
    const rows = await this.prisma.deploymentEvent.findMany({
      where: { deploymentId: id, ...(after && /^\d+$/.test(after) ? { id: { gt: BigInt(after) } } : {}) },
      orderBy: { id: 'asc' },
      take: 500,
    });
    return rows.map((e) => ({ id: String(e.id), at: e.at.toISOString(), level: e.level as DeploymentEventDto['level'], stepKey: e.stepKey, message: e.message }));
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string, @CorrelationId() correlationId: string) {
    const d = await this.load(p, id);
    authorize(p, 'approve', 'Instance', { tenantId: d.tenantId });
    const updated = await this.prisma.deployment.updateMany({
      where: { id, status: 'AWAITING_APPROVAL' },
      data: { approvedById: p.userId, approvedAt: new Date() },
    });
    if (updated.count === 0) throw conflict('NOT_AWAITING_APPROVAL', 'This deployment is not waiting for approval.');
    await this.prisma.deploymentEvent.create({ data: { deploymentId: id, level: 'info', stepKey: 'phase:approval', message: `Approved by ${p.email}.` } });
    await this.queues.enqueueDeployment(id, 'approved');
    await this.audit.record({ principal: p, tenantId: d.tenantId, resourceType: 'Deployment', resourceId: id, action: 'APPROVE', correlationId });
    return toDeploymentSummary(await this.prisma.deployment.findUniqueOrThrow({ where: { id } }));
  }

  /** Cooperative cancel: the worker stops before the next resource and records what completed. */
  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string, @CorrelationId() correlationId: string) {
    const d = await this.load(p, id);
    authorize(p, 'deploy', 'Instance', { tenantId: d.tenantId });
    if (!['QUEUED', 'RUNNING', 'AWAITING_APPROVAL'].includes(d.status)) throw conflict('NOT_CANCELLABLE', 'This deployment already finished.');
    await this.prisma.deployment.update({ where: { id }, data: { cancelRequestedAt: new Date() } });
    await this.prisma.deploymentEvent.create({ data: { deploymentId: id, level: 'warn', message: `Cancellation requested by ${p.email}.` } });
    // A deployment parked at approval has no running job; wake it so the worker finalizes the cancel.
    if (d.status !== 'RUNNING') await this.queues.enqueueDeployment(id, `cancel-${Date.now()}`);
    await this.audit.record({ principal: p, tenantId: d.tenantId, resourceType: 'Deployment', resourceId: id, action: 'CANCEL', correlationId });
    return toDeploymentSummary(await this.prisma.deployment.findUniqueOrThrow({ where: { id } }));
  }

  @Post(':id/retry')
  @HttpCode(202)
  async retry(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string, @CorrelationId() correlationId: string) {
    const d = await this.load(p, id);
    authorize(p, d.kind === 'APPLY' ? 'deploy' : 'destroy', 'Instance', { tenantId: d.tenantId });
    return toDeploymentSummary(await this.launcher.retry(d, p, correlationId));
  }

  private async load(p: RequestPrincipal, id: string) {
    const d = await this.prisma.deployment.findFirst({ where: { id, ...tenantScope(p) } });
    if (!d) throw notFound('Deployment');
    authorize(p, 'read', 'Deployment', { tenantId: d.tenantId });
    return d;
  }
}
