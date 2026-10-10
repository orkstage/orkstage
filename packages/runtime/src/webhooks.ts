import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup as lookupCallback, type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

/** Retry schedule after a failed attempt, in seconds (docs/specs/integration-api.md). */
export const WEBHOOK_RETRY_DELAYS_S = [60, 300, 1800, 7200, 21600];
export const WEBHOOK_DISABLE_AFTER_FAILURES = 20;
const TIMEOUT_MS = 10_000;

export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

/** Inverse of signWebhook, with replay protection; exported for docs/tests and receivers in Node. */
export function verifyWebhook(secret: string, header: string, rawBody: string, toleranceS = 300, nowS = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowS - t) > toleranceS || !parts.v1) return false;
  const expected = Buffer.from(signWebhook(secret, t, rawBody).split('v1=')[1]!);
  const given = Buffer.from(parts.v1);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Addresses a webhook may never reach: private, loopback, link local, shared, documentation,
 * benchmark, multicast and reserved ranges, plus IPv6 forms that embed or translate to IPv4
 * (mapped, NAT64, 6to4), which would otherwise smuggle a private IPv4 address past the check.
 */
const V4: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V6: [string, number][] = [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
];

/** One list per family: Node's BlockList also matches IPv6 addresses against IPv4 rules by their last 32 bits. */
function blockList(family: 'ipv4' | 'ipv6', nets: [string, number][]): BlockList {
  const list = new BlockList();
  for (const [net, prefix] of nets) list.addSubnet(net, prefix, family);
  return list;
}
const BLOCKED_V4 = blockList('ipv4', V4);
const BLOCKED_V6 = blockList('ipv6', V6);

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return BLOCKED_V4.check(ip, 'ipv4');
  if (family === 6) return BLOCKED_V6.check(ip, 'ipv6');
  return true; // not an address: refuse rather than guess
}

export class UnsafeWebhookUrlError extends Error {}

/**
 * SSRF protection (spec §43): https only, no credentials in the URL, and the host must not
 * resolve to private, loopback, link-local or multicast addresses. Checked at registration and
 * again before every delivery (DNS can change).
 */
export async function assertSafeWebhookUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeWebhookUrlError('The URL is not valid.');
  }
  if (url.username || url.password) throw new UnsafeWebhookUrlError('URLs with credentials are not allowed.');
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new UnsafeWebhookUrlError('Webhook URLs must use https.');
  }
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new UnsafeWebhookUrlError('Webhook URLs must resolve to public addresses.');
  }
  return url;
}

export interface WebhookAttempt {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * DNS lookup for outgoing webhook connections that refuses blocked addresses. Validating at
 * connect time (not only before the request) closes DNS rebinding: the address checked is the
 * address used.
 */
function guardedLookup(hostname: string, options: { all?: boolean; family?: number }, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) {
  lookupCallback(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error('Webhook URLs must resolve to public addresses.'), { code: 'EBLOCKED' }), []);
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
}

/** One signed POST. Redirects are not followed; the response body is ignored. */
export async function sendWebhook(opts: {
  url: string;
  secret: string;
  event: string;
  deliveryId: string;
  payload: unknown;
  allowPrivate: boolean;
}): Promise<WebhookAttempt> {
  try {
    const url = await assertSafeWebhookUrl(opts.url, opts.allowPrivate);
    const body = JSON.stringify(opts.payload);
    const headers = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      'user-agent': 'OrkStage-Webhooks/1.0',
      'orkstage-event': opts.event,
      'orkstage-delivery': opts.deliveryId,
      'orkstage-signature': signWebhook(opts.secret, Math.floor(Date.now() / 1000), body),
    };
    const status = await new Promise<number>((resolve, reject) => {
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(
        url,
        { method: 'POST', headers, timeout: TIMEOUT_MS, ...(opts.allowPrivate ? {} : { lookup: guardedLookup as never }) },
        (res) => {
          res.resume(); // the body is ignored; drain it so the socket is released
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('timeout', () => req.destroy(new Error('Webhook delivery timed out.')));
      req.on('error', reject);
      req.end(body);
    });
    return status >= 200 && status < 300 ? { ok: true, status } : { ok: false, status, error: `HTTP ${status}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 300) };
  }
}
