// SPDX-License-Identifier: AGPL-3.0-only
import type { PrismaClient, User } from '@orkstage/database';
import { Inject, Injectable } from '@nestjs/common';
import { PRISMA } from '../infra/infra.module.js';

/** What a sign in proved about the person, whatever the protocol (OIDC claims, GitHub API). */
export interface ExternalIdentityClaims {
  /** The provider's stable id for the person (OIDC `sub`, GitHub user id). */
  subject: string;
  email?: string;
  /** Only an email the provider vouches for may link to an existing account. */
  emailVerified: boolean;
  name?: string;
}

/** Picks the identity GitHub vouches for: the primary email, and only when it is verified. */
export function githubIdentity(
  user: { id: number | string; login?: string; name?: string | null },
  emails: { email: string; primary: boolean; verified: boolean }[],
): ExternalIdentityClaims {
  const primary = emails.find((e) => e.primary && e.verified);
  return { subject: String(user.id), email: primary?.email, emailVerified: Boolean(primary), name: user.name || user.login || undefined };
}

/**
 * Account resolution after a sign in (spec §14, acceptance 96.1): an existing link wins; otherwise
 * link to the existing user with the same verified email; otherwise create the account from
 * pending invitations, or as a viewer when exactly one tenant allows the email domain. Unknown
 * people never get an account by default, and an unverified email never links.
 */
@Injectable()
export class IdentityLinker {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async resolve(providerId: string, identity: ExternalIdentityClaims): Promise<User | null> {
    const linked = await this.prisma.externalIdentity.findUnique({
      where: { providerId_subject: { providerId, subject: identity.subject } },
      include: { user: true },
    });
    if (linked) {
      await this.prisma.externalIdentity.update({ where: { id: linked.id }, data: { lastLoginAt: new Date() } });
      return linked.user.disabledAt ? null : linked.user;
    }
    const email = identity.email?.toLowerCase() ?? '';
    if (!identity.emailVerified || !email.includes('@')) return null;
    let user = await this.prisma.user.findUnique({ where: { email } });
    // Pending invitations for this address: the first sign in creates the account with those
    // memberships and accepts them (an explicit invitation wins over domain auto join).
    const invitations = await this.prisma.invitation.findMany({ where: { email, acceptedAt: null, expiresAt: { gt: new Date() } } });
    if (!user && invitations.length > 0) {
      user = await this.prisma.user.create({
        data: { email, name: identity.name ?? email, memberships: { create: invitations.map((i) => ({ tenantId: i.tenantId, role: i.role })) } },
      });
      await this.prisma.invitation.updateMany({ where: { id: { in: invitations.map((i) => i.id) } }, data: { acceptedAt: new Date() } });
    }
    if (!user) {
      const domain = email.split('@')[1]!;
      // Auto join only when exactly one tenant claims the domain: with several, there is no safe way
      // to tell which customer the person belongs to, so they need an explicit invitation instead.
      const tenants = await this.prisma.tenant.findMany({ where: { allowedEmailDomains: { has: domain } }, select: { id: true }, take: 2 });
      if (tenants.length !== 1) return null;
      user = await this.prisma.user.create({
        data: { email, name: identity.name ?? email, memberships: { create: { tenantId: tenants[0]!.id, role: 'CustomerViewer' } } },
      });
    }
    if (user.disabledAt) return null;
    await this.prisma.externalIdentity.create({
      data: { providerId, subject: identity.subject, userId: user.id, email, lastLoginAt: new Date() },
    });
    return user;
  }
}
