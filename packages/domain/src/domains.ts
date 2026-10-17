// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Custom domains (spec §23, open item 9): ownership is proven with a TXT record, traffic arrives
 * through a CNAME to the platform hostname, and certificates are watched until they expire.
 */
export const DOMAIN_CHALLENGE_LABEL = '_orkstage-challenge';

/** Days before expiry when the tenant is warned, once each. */
export const CERTIFICATE_NOTICE_DAYS = [30, 14, 7, 1] as const;

/** A pending custom domain fails after this long without its TXT record. */
export const DOMAIN_VERIFICATION_WINDOW_MS = 7 * 86_400_000;

export function challengeName(hostname: string): string {
  return `${DOMAIN_CHALLENGE_LABEL}.${hostname}`;
}

export interface DomainRecord {
  purpose: 'ownership' | 'routing' | 'certificate';
  name: string;
  type: 'TXT' | 'CNAME' | 'A';
  value: string;
}

/** The records the owner of a custom domain creates at their DNS provider. */
export function domainRecords(
  d: { hostname: string; kind: string; verificationToken: string; certificateRecords?: unknown },
  routeTo: string | null,
): DomainRecord[] {
  if (d.kind !== 'CUSTOM') return [];
  const records: DomainRecord[] = [{ purpose: 'ownership', name: challengeName(d.hostname), type: 'TXT', value: d.verificationToken }];
  if (routeTo) records.push({ purpose: 'routing', name: d.hostname, type: 'CNAME', value: routeTo });
  const cert = Array.isArray(d.certificateRecords) ? (d.certificateRecords as { name: string; type: DomainRecord['type']; value: string }[]) : [];
  for (const r of cert) records.push({ purpose: 'certificate', name: r.name, type: r.type, value: r.value });
  return records;
}

/** True when the hostname is the zone itself or inside it. */
export function isWithinZone(hostname: string, zone: string): boolean {
  return hostname === zone || hostname.endsWith(`.${zone}`);
}

export type CertificateState = 'NONE' | 'PENDING_VALIDATION' | 'ISSUED' | 'EXPIRING' | 'EXPIRED' | 'FAILED';

/** The stored certificate state from what the provider reports: issued turns expiring 30 days ahead. */
export function certificateState(status: 'PENDING_VALIDATION' | 'ISSUED' | 'EXPIRED' | 'FAILED', notAfter: string | undefined, now = new Date()): CertificateState {
  if (status !== 'ISSUED') return status;
  if (!notAfter) return 'ISSUED';
  const left = Date.parse(notAfter) - now.getTime();
  if (left <= 0) return 'EXPIRED';
  return left <= CERTIFICATE_NOTICE_DAYS[0] * 86_400_000 ? 'EXPIRING' : 'ISSUED';
}

/** The expiry warning due now, if any: the smallest threshold reached that was not sent yet. */
export function dueExpiryNotice(notAfter: Date, lastNoticeDays: number | null, now = new Date()): number | null {
  const daysLeft = (notAfter.getTime() - now.getTime()) / 86_400_000;
  if (daysLeft <= 0) return null;
  const reached = CERTIFICATE_NOTICE_DAYS.filter((d) => daysLeft <= d);
  if (reached.length === 0) return null;
  const smallest = Math.min(...reached);
  return lastNoticeDays === null || smallest < lastNoticeDays ? smallest : null;
}
