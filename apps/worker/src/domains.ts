// SPDX-License-Identifier: AGPL-3.0-only
import type { ResourceOutputs } from '@orkstage/cloud-core';
import type { Domain, InstanceResource } from '@orkstage/database';
import { certificateState, challengeName, dueExpiryNotice, DOMAIN_VERIFICATION_WINDOW_MS } from '@orkstage/domain';
import { publicDnsLookup, toCloudTarget } from '@orkstage/runtime';
import { randomUUID } from 'node:crypto';
import { notify, systemAudit, type WorkerContext } from './context.js';

/** A pending domain is looked up at most this often. */
const VERIFY_EVERY_MS = 60_000;
/** Certificates of one resource are read at most this often (provider APIs cost money). */
const CERTIFICATES_EVERY_MS = 10 * 60_000;

type Lookup = (name: string, type: 'TXT' | 'CNAME') => Promise<string[]>;
type TargetRow = Parameters<typeof toCloudTarget>[0];

/**
 * Custom domains and certificates (spec §23, open item 9), on the health tick:
 * - records the platform subdomain of every active `dns` resource as a verified domain;
 * - looks up the TXT record of pending custom domains, verifies them or fails them after 7 days;
 * - reads certificates from the adapter, tracks validation and expiry, and warns before expiry.
 */
export class DomainMonitor {
  private readonly lastCertificates = new Map<string, number>();

  constructor(
    private readonly ctx: WorkerContext,
    private readonly lookupPublic: Lookup = publicDnsLookup,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async tick(targets: Map<string, TargetRow>): Promise<void> {
    const { prisma } = this.ctx;
    const resources = await prisma.instanceResource.findMany({ where: { status: 'ACTIVE', type: { in: ['dns', 'web.frontend'] } } });
    for (const r of resources) await this.syncPlatformDomain(r);
    const pending = await prisma.domain.findMany({
      where: { kind: 'CUSTOM', status: 'PENDING_VERIFICATION', OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(this.now().getTime() - VERIFY_EVERY_MS) } }] },
      take: 100,
    });
    for (const d of pending) await this.verify(d, resources, targets);
    for (const r of resources) await this.checkCertificates(r, targets);
  }

  /** The `dns` resource's platform hostname is a domain too: verified by construction. */
  private async syncPlatformDomain(r: InstanceResource) {
    const fqdn = r.type === 'dns' ? String((r.outputs as ResourceOutputs | null)?.fqdn ?? '') : '';
    if (!fqdn) return;
    const existing = await this.ctx.prisma.domain.findUnique({ where: { hostname: fqdn } });
    if (existing) return;
    await this.ctx.prisma.domain
      .create({ data: { tenantId: r.tenantId, instanceId: r.instanceId, resourceId: r.resourceId, hostname: fqdn, kind: 'PLATFORM', status: 'VERIFIED', verifiedAt: this.now(), verificationToken: '' } })
      .catch((err: { code?: string }) => {
        if (err.code !== 'P2002') throw err;
      });
  }

  private lookupFor(r: InstanceResource | undefined, targets: Map<string, TargetRow>): Lookup {
    const target = r ? targets.get(r.targetId) : undefined;
    const adapter = r && this.ctx.registry.has(r.provider) ? this.ctx.registry.get(r.provider) : null;
    // Simulated targets answer from the simulated DNS, so verification works without a real zone.
    if (adapter?.simulated && adapter.lookupDns && target) {
      const ctx = { target: toCloudTarget(target), region: r!.region, correlationId: `domain-${randomUUID()}` };
      return (name, type) => adapter.lookupDns!(ctx, name, type);
    }
    return this.lookupPublic;
  }

  private async verify(d: Domain, resources: InstanceResource[], targets: Map<string, TargetRow>) {
    const { prisma, logger } = this.ctx;
    const r = resources.find((x) => x.instanceId === d.instanceId && x.resourceId === d.resourceId);
    const now = this.now();
    let found = false;
    let error: string | null = null;
    try {
      found = (await this.lookupFor(r, targets)(challengeName(d.hostname), 'TXT')).some((v) => v.trim() === d.verificationToken);
      if (!found) error = `No TXT record ${challengeName(d.hostname)} with the expected value yet.`;
    } catch (err) {
      error = `DNS lookup failed: ${(err as Error).message.slice(0, 200)}`;
      logger.warn({ hostname: d.hostname, err: error }, 'domain lookup failed');
    }

    if (found) {
      await prisma.domain.update({ where: { id: d.id }, data: { status: 'VERIFIED', verifiedAt: now, lastCheckedAt: now, lastError: null } });
      await notify(this.ctx, {
        tenantId: d.tenantId,
        event: 'domain.verified',
        title: `${d.hostname} is verified`,
        body: 'Deploy the instance to attach it and request its certificate.',
        link: `/instances/${d.instanceId}?tab=domains`,
        data: { domainId: d.id, instanceId: d.instanceId },
      });
      await systemAudit(this.ctx, { tenantId: d.tenantId, resourceType: 'Domain', resourceId: d.id, action: 'VERIFY', changes: { hostname: d.hostname } });
      return;
    }
    const expired = now.getTime() - d.createdAt.getTime() > DOMAIN_VERIFICATION_WINDOW_MS;
    await prisma.domain.update({ where: { id: d.id }, data: { lastCheckedAt: now, lastError: error, ...(expired ? { status: 'FAILED' } : {}) } });
    if (expired) {
      await notify(this.ctx, {
        tenantId: d.tenantId,
        event: 'domain.verification_failed',
        title: `${d.hostname} could not be verified`,
        body: 'Its TXT record did not appear within 7 days. Check the record and verify again.',
        link: `/instances/${d.instanceId}?tab=domains`,
        data: { domainId: d.id, instanceId: d.instanceId },
      });
    }
  }

  private async checkCertificates(r: InstanceResource, targets: Map<string, TargetRow>) {
    const { prisma, registry, logger } = this.ctx;
    const key = `${r.instanceId}:${r.resourceId}`;
    if (this.now().getTime() - (this.lastCertificates.get(key) ?? 0) < CERTIFICATES_EVERY_MS) return;
    this.lastCertificates.set(key, this.now().getTime());
    const target = targets.get(r.targetId);
    if (!target || !registry.has(r.provider)) return;
    const adapter = registry.get(r.provider);
    if (!adapter.getCertificates) return;
    let certs;
    try {
      certs = await adapter.getCertificates(
        { target: toCloudTarget(target), region: r.region, correlationId: `cert-${randomUUID()}` },
        { resourceId: r.resourceId, serviceKind: r.type, capability: r.capability, name: r.name, providerResourceId: r.providerResourceId ?? undefined, outputs: r.outputs as never },
      );
    } catch (err) {
      logger.warn({ resourceId: r.resourceId, err: (err as Error).message }, 'certificate read failed');
      return;
    }
    const domains = await prisma.domain.findMany({ where: { instanceId: r.instanceId, resourceId: r.resourceId, status: 'VERIFIED' } });
    for (const d of domains) {
      const cert = certs.find((c) => c.hostname === d.hostname);
      if (!cert) continue;
      const state = certificateState(cert.status, cert.notAfter, this.now());
      const expiresAt = cert.notAfter ? new Date(cert.notAfter) : null;
      const notice = expiresAt && (state === 'EXPIRING' || state === 'ISSUED') ? dueExpiryNotice(expiresAt, d.expiryNoticeDays, this.now()) : null;
      // A renewed certificate starts the warnings over.
      const renewed = expiresAt && d.certificateExpiresAt && expiresAt > d.certificateExpiresAt;
      await prisma.domain.update({
        where: { id: d.id },
        data: {
          certificateStatus: state,
          certificateExpiresAt: expiresAt,
          certificateRecords: (cert.records ?? []) as object[],
          ...(notice !== null ? { expiryNoticeDays: notice } : renewed ? { expiryNoticeDays: null } : {}),
        },
      });
      if (d.kind === 'CUSTOM' && state === 'ISSUED' && d.certificateStatus !== 'ISSUED' && d.certificateStatus !== 'EXPIRING') {
        await notify(this.ctx, {
          tenantId: d.tenantId,
          event: 'domain.certificate_issued',
          title: `Certificate issued for ${d.hostname}`,
          body: 'Deploy the instance if it does not serve HTTPS on this hostname yet.',
          link: `/instances/${d.instanceId}?tab=domains`,
          data: { domainId: d.id, instanceId: d.instanceId },
        });
      }
      if (notice !== null) {
        await notify(this.ctx, {
          tenantId: d.tenantId,
          event: 'domain.certificate_expiring',
          title: `Certificate for ${d.hostname} expires in ${notice === 1 ? 'a day' : `${notice} days`}`,
          body: `It is valid until ${expiresAt!.toUTCString()}. Managed certificates renew on their own while their validation records stay in place.`,
          link: `/instances/${d.instanceId}?tab=domains`,
          data: { domainId: d.id, instanceId: d.instanceId, daysLeft: notice },
        });
      }
    }
  }
}
