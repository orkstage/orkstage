import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function shortId(id: string | null | undefined, n = 8): string {
  if (!id) return '—';
  return id.length > n ? id.slice(0, n) : id;
}

const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTimeFmt.format(d);
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : timeFmt.format(d);
}

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.round((now - t) / 1000);
  if (s < 0) return 'just now';
  if (s < 45) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function durationBetween(start: string | null | undefined, end: string | null | undefined, now = Date.now()): number | null {
  if (!start) return null;
  const a = new Date(start).getTime();
  const b = end ? new Date(end).getTime() : now;
  return Number.isNaN(a) || Number.isNaN(b) ? null : b - a;
}

export function formatMoney(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 41);
}

export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  const s = value.replace(/[_.-]+/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Splits a comma/whitespace separated list. */
export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const SECRET_KEY = /secret|password|passwd|token|credential|private[-_]?key|api[-_]?key|access[-_]?key|connection[-_]?string/i;
const REFERENCE_VALUE = /^(secret|env|vault|ssm|kms|arn|azkv|oci-vault):\/{0,2}|^arn:aws[a-z-]*:secretsmanager:/i;

/**
 * Outputs are displayed, but anything named like a secret is shown only when it is a reference
 * (e.g. `secret://db/credentials`), never as a literal value.
 */
export function displayOutput(key: string, value: unknown): { text: string; hidden: boolean; reference: boolean } {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (SECRET_KEY.test(key)) {
    if (typeof value === 'string' && REFERENCE_VALUE.test(value)) return { text: value, hidden: false, reference: true };
    return { text: 'hidden', hidden: true, reference: false };
  }
  return { text: text ?? '', hidden: false, reference: false };
}

export function looksLikeSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
