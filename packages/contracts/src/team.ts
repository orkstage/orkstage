import { z } from 'zod';

/** Roles inside a tenant (customer side). Platform roles are managed separately. */
export const TENANT_ROLES = ['CustomerOwner', 'CustomerAdmin', 'CustomerDeveloper', 'CustomerViewer'] as const;
export type TenantRoleName = (typeof TENANT_ROLES)[number];

export const inviteMemberSchema = z.object({
  email: z.email().max(254),
  role: z.enum(TENANT_ROLES),
});

export const updateMemberSchema = z.object({ role: z.enum(TENANT_ROLES) });

export interface MemberDto {
  userId: string;
  email: string;
  name: string;
  role: TenantRoleName;
  joinedAt: string;
  /** Signed in at least once through SSO (otherwise only dev login or never). */
  lastLoginAt: string | null;
}

export interface InvitationDto {
  id: string;
  email: string;
  role: TenantRoleName;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface TeamDto {
  members: MemberDto[];
  invitations: InvitationDto[];
}

/** Returned once when an invitation is created: the link is not stored and cannot be shown again. */
export interface InvitationCreatedDto {
  invitation: InvitationDto;
  link: string;
}

/** What an invitation link shows before it is accepted (no secrets, the address partly hidden). */
export interface InvitationPreviewDto {
  tenantName: string;
  role: TenantRoleName;
  emailHint: string;
  status: 'pending' | 'accepted' | 'expired';
}
