import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

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

function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
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
    await assertSafeWebhookUrl(opts.url, opts.allowPrivate);
    const body = JSON.stringify(opts.payload);
    const res = await fetch(opts.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'OrkStage-Webhooks/1.0',
        'orkstage-event': opts.event,
        'orkstage-delivery': opts.deliveryId,
        'orkstage-signature': signWebhook(opts.secret, Math.floor(Date.now() / 1000), body),
      },
      body,
    });
    await res.body?.cancel();
    return res.status >= 200 && res.status < 300 ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 300) };
  }
}
