import { inviteMemberSchema, updateMemberSchema, type InvitationCreatedDto, type InvitationDto, type InvitationPreviewDto, type MemberDto, type TeamDto, type TenantRoleName } from '@orkstage/contracts';
import type { Invitation, PrismaClient } from '@orkstage/database';
import { sha256 } from '@orkstage/domain';
import type { PlatformConfig } from '@orkstage/runtime';
import { Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, Public } from '../common/auth.js';
import { AppError, conflict, notFound, unprocessable } from '../common/errors.js';
import { ApiZodBody, ZodBody } from '../common/validation.js';
import { CONFIG, PRISMA, Queues } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';

const INVITATION_DAYS = 7;

const toInvitationDto = (i: Invitation): InvitationDto => ({
  id: i.id,
  email: i.email,
  role: i.role as TenantRoleName,
  createdAt: i.createdAt.toISOString(),
  expiresAt: i.expiresAt.toISOString(),
  expired: i.expiresAt < new Date(),
});

/** `jane.doe@acme.com` becomes `ja***@acme.com`: enough to recognise, not to harvest. */
const hideEmail = (email: string) => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
};

/**
 * Tenant members and invitations (spec §12, §14). Owners invite by email with a role; the
 * invitation token is random, stored only as a hash, shown once to the inviter and emailed. The
 * invited person accepts it signed in with that same address (or simply signs in through SSO for
 * the first time). A tenant always keeps at least one owner.
 */
@ApiTags('tenants')
@Controller()
export class TeamController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CONFIG) private readonly config: PlatformConfig,
    private readonly queues: Queues,
    private readonly audit: AuditService,
  ) {}

  @Get('tenants/:tenantId/members')
  async team(@CurrentPrincipal() p: RequestPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<TeamDto> {
    authorize(p, 'read', 'Member', { tenantId });
    const [memberships, invitations] = await Promise.all([
      this.prisma.membership.findMany({ where: { tenantId }, include: { user: { include: { externalIdentities: { orderBy: { lastLoginAt: 'desc' }, take: 1 } } } }, orderBy: { createdAt: 'asc' } }),
      this.prisma.invitation.findMany({ where: { tenantId, acceptedAt: null }, orderBy: { createdAt: 'desc' } }),
    ]);
    const members: MemberDto[] = memberships.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      role: m.role as TenantRoleName,
      joinedAt: m.createdAt.toISOString(),
      lastLoginAt: m.user.externalIdentities[0]?.lastLoginAt?.toISOString() ?? null,
    }));
    return { members, invitations: invitations.map(toInvitationDto) };
  }

  @Post('tenants/:tenantId/invitations')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiZodBody(inviteMemberSchema)
  async invite(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @ZodBody(inviteMemberSchema) body: z.infer<typeof inviteMemberSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<InvitationCreatedDto> {
    authorize(p, 'create', 'Member', { tenantId });
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw notFound('Tenant');
    const email = body.email.toLowerCase();
    const existing = await this.prisma.membership.findFirst({ where: { tenantId, user: { email } } });
    if (existing) throw conflict('ALREADY_MEMBER', `${email} is already a member of ${tenant.name}.`);

    // A new invitation for the same address replaces the previous one (its link stops working).
    await this.prisma.invitation.deleteMany({ where: { tenantId, email, acceptedAt: null } });
    const token = randomBytes(32).toString('base64url');
    const invitation = await this.prisma.invitation.create({
      data: { tenantId, email, role: body.role, tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITATION_DAYS * 86_400_000) },
    });
    const link = `${this.config.WEB_PUBLIC_URL.replace(/\/+$/, '')}/invite/${token}`;
    await this.queues.enqueueInvitationEmail({ kind: 'invitation', to: email, tenantName: tenant.name, inviterName: p.name || p.email, role: body.role, link, expiresAt: invitation.expiresAt.toISOString() });
    await this.audit.record({ principal: p, tenantId, resourceType: 'Invitation', resourceId: invitation.id, action: 'INVITE', correlationId, changes: { email, role: body.role } });
    return { invitation: toInvitationDto(invitation), link };
  }

  @Delete('tenants/:tenantId/invitations/:id')
  @HttpCode(204)
  async revoke(@CurrentPrincipal() p: RequestPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string, @CorrelationId() correlationId: string) {
    authorize(p, 'delete', 'Member', { tenantId });
    const { count } = await this.prisma.invitation.deleteMany({ where: { id, tenantId, acceptedAt: null } });
    if (count === 0) throw notFound('Invitation');
    await this.audit.record({ principal: p, tenantId, resourceType: 'Invitation', resourceId: id, action: 'REVOKE', correlationId });
  }

  @Patch('tenants/:tenantId/members/:userId')
  @ApiZodBody(updateMemberSchema)
  async updateRole(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @ZodBody(updateMemberSchema) body: z.infer<typeof updateMemberSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<MemberDto> {
    authorize(p, 'update', 'Member', { tenantId });
    const membership = await this.prisma.membership.findUnique({ where: { tenantId_userId: { tenantId, userId } }, include: { user: true } });
    if (!membership) throw notFound('Member');
    if (membership.role === 'CustomerOwner' && body.role !== 'CustomerOwner') await this.assertAnotherOwner(tenantId, userId);
    const updated = await this.prisma.membership.update({ where: { id: membership.id }, data: { role: body.role } });
    await this.audit.record({ principal: p, tenantId, resourceType: 'Membership', resourceId: membership.id, action: 'CHANGE_ROLE', correlationId, changes: { userId, from: membership.role, to: body.role } });
    return { userId, email: membership.user.email, name: membership.user.name, role: updated.role as TenantRoleName, joinedAt: updated.createdAt.toISOString(), lastLoginAt: null };
  }

  /** Owners remove members; anyone can leave a tenant (unless they are its last owner). */
  @Delete('tenants/:tenantId/members/:userId')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: RequestPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('userId', ParseUUIDPipe) userId: string, @CorrelationId() correlationId: string) {
    if (userId !== p.userId) authorize(p, 'delete', 'Member', { tenantId });
    const membership = await this.prisma.membership.findUnique({ where: { tenantId_userId: { tenantId, userId } } });
    if (!membership) throw notFound('Member');
    if (membership.role === 'CustomerOwner') await this.assertAnotherOwner(tenantId, userId);
    await this.prisma.membership.delete({ where: { id: membership.id } });
    await this.audit.record({ principal: p, tenantId, resourceType: 'Membership', resourceId: membership.id, action: userId === p.userId ? 'LEAVE' : 'REMOVE', correlationId, changes: { userId, role: membership.role } });
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('invitations/:token')
  async preview(@Param('token') token: string): Promise<InvitationPreviewDto> {
    const invitation = await this.prisma.invitation.findUnique({ where: { tokenHash: sha256(token) }, include: { tenant: { select: { name: true } } } });
    if (!invitation) throw notFound('Invitation');
    return {
      tenantName: invitation.tenant.name,
      role: invitation.role as TenantRoleName,
      emailHint: hideEmail(invitation.email),
      status: invitation.acceptedAt ? 'accepted' : invitation.expiresAt < new Date() ? 'expired' : 'pending',
    };
  }

  @Post('invitations/:token/accept')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async accept(@CurrentPrincipal() p: RequestPrincipal, @Param('token') token: string, @CorrelationId() correlationId: string): Promise<{ tenantId: string }> {
    if (p.apiKey) throw new AppError(403, 'API_KEY_NOT_ALLOWED', 'Invitations are accepted by a signed in person.');
    const invitation = await this.prisma.invitation.findUnique({ where: { tokenHash: sha256(token) } });
    if (!invitation) throw notFound('Invitation');
    if (invitation.acceptedAt) throw conflict('INVITATION_USED', 'This invitation was already accepted.');
    if (invitation.expiresAt < new Date()) throw unprocessable('INVITATION_EXPIRED', 'This invitation expired. Ask for a new one.');
    if (invitation.email !== p.email.toLowerCase()) {
      throw new AppError(403, 'INVITATION_EMAIL_MISMATCH', `This invitation is for another email address. Sign in as ${hideEmail(invitation.email)} to accept it.`);
    }
    await this.prisma.$transaction([
      this.prisma.membership.upsert({
        where: { tenantId_userId: { tenantId: invitation.tenantId, userId: p.userId } },
        update: { role: invitation.role },
        create: { tenantId: invitation.tenantId, userId: p.userId, role: invitation.role },
      }),
      this.prisma.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } }),
    ]);
    await this.audit.record({ principal: p, tenantId: invitation.tenantId, resourceType: 'Invitation', resourceId: invitation.id, action: 'ACCEPT', correlationId, changes: { role: invitation.role } });
    return { tenantId: invitation.tenantId };
  }

  private async assertAnotherOwner(tenantId: string, userId: string) {
    const owners = await this.prisma.membership.count({ where: { tenantId, role: 'CustomerOwner', userId: { not: userId } } });
    if (owners === 0) throw unprocessable('LAST_OWNER', 'A tenant needs at least one owner. Make someone else an owner first.');
  }
}
