import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** First `n` characters of an id (empty for a missing id; callers show the locale placeholder). */
export function shortId(id: string | null | undefined, n = 8): string {
  if (!id) return '';
  return id.length > n ? id.slice(0, n) : id;
}

/*
 * Dates, relative times, durations, numbers and money are formatted for the active locale by
 * `useFormat()` in src/i18n/format.ts.
 */

export function durationBetween(start: string | null | undefined, end: string | null | undefined, now = Date.now()): number | null {
  if (!start) return null;
  const a = new Date(start).getTime();
  const b = end ? new Date(end).getTime() : now;
  return Number.isNaN(a) || Number.isNaN(b) ? null : b - a;
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
  if (!value) return '';
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
    return { text: '', hidden: true, reference: false };
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
