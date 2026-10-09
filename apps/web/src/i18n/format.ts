'use client';

import { useMemo } from 'react';
import { useLocale, useTranslations } from 'use-intl';

export interface Formatters {
  locale: string;
  /** Placeholder for a missing value ("n/a"). */
  empty: string;
  dateTime(iso: string | null | undefined): string;
  date(iso: string | null | undefined): string;
  time(iso: string | null | undefined): string;
  /** Hours and minutes, for chart axes. */
  shortTime(ms: number): string;
  /** Day and short month ("Oct 6", "6 de out."), for chart axes. */
  dayMonth(date: Date): string;
  relative(iso: string | null | undefined, now?: number): string;
  duration(ms: number | null | undefined): string;
  /** Cost estimates are in USD; the amount is formatted for the active locale (US$ 1.234,56 in pt-BR). */
  money(value: number | null | undefined, currency?: string): string;
  number(value: number | null | undefined, digits?: number): string;
  percent(value: number | null | undefined, digits?: number): string;
}

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Builds Intl formatters for a locale. Times use the viewer's own time zone. */
export function createFormatters(locale: string, empty: string, justNow: string): Formatters {
  const dateTimeFmt = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const dateFmt = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: '2-digit' });
  const timeFmt = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const shortTimeFmt = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const dayMonthFmt = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
  const relativeFmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  const unit = (u: 'hour' | 'minute' | 'second') => new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'narrow' });
  const hours = unit('hour');
  const minutes = unit('minute');
  const seconds = unit('second');
  const numberFmts = new Map<number, Intl.NumberFormat>();
  const numberFmt = (digits: number) => {
    let f = numberFmts.get(digits);
    if (!f) numberFmts.set(digits, (f = new Intl.NumberFormat(locale, { maximumFractionDigits: digits })));
    return f;
  };

  return {
    locale,
    empty,
    dateTime: (iso) => {
      const d = parse(iso);
      return d ? dateTimeFmt.format(d) : iso || empty;
    },
    date: (iso) => {
      const d = parse(iso);
      return d ? dateFmt.format(d) : iso || empty;
    },
    time: (iso) => {
      const d = parse(iso);
      return d ? timeFmt.format(d) : iso || empty;
    },
    shortTime: (ms) => shortTimeFmt.format(new Date(ms)),
    dayMonth: (date) => (Number.isNaN(date.getTime()) ? empty : dayMonthFmt.format(date)),
    relative: (iso, now = Date.now()) => {
      const d = parse(iso);
      if (!d) return iso || empty;
      // Past times read "5 min ago"; future ones (a scheduled retry) read "in 5 min".
      const diff = Math.round((now - d.getTime()) / 1000);
      const sign = diff >= 0 ? -1 : 1;
      const s = Math.abs(diff);
      if (s < 5) return justNow;
      if (s < 45) return relativeFmt.format(sign * s, 'second');
      const m = Math.round(s / 60);
      if (m < 60) return relativeFmt.format(sign * m, 'minute');
      const h = Math.round(m / 60);
      if (h < 48) return relativeFmt.format(sign * h, 'hour');
      return relativeFmt.format(sign * Math.round(h / 24), 'day');
    },
    duration: (ms) => {
      if (ms === null || ms === undefined || Number.isNaN(ms) || ms < 0) return empty;
      const total = Math.floor(ms / 1000);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      if (h > 0) return `${hours.format(h)} ${minutes.format(m)} ${seconds.format(s)}`;
      if (m > 0) return `${minutes.format(m)} ${seconds.format(s)}`;
      return seconds.format(s);
    },
    money: (value, currency = 'USD') => {
      if (value === null || value === undefined || Number.isNaN(value)) return empty;
      try {
        return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
      } catch {
        return `${numberFmt(2).format(value)} ${currency}`;
      }
    },
    number: (value, digits = 2) => (value === null || value === undefined || Number.isNaN(value) ? empty : numberFmt(digits).format(value)),
    percent: (value, digits = 0) =>
      value === null || value === undefined || Number.isNaN(value)
        ? empty
        : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: digits }).format(value),
  };
}

/** Locale-aware dates, relative times, durations, numbers and money for client components. */
export function useFormat(): Formatters {
  const locale = useLocale();
  const t = useTranslations('common');
  const empty = t('empty');
  const justNow = t('justNow');
  return useMemo(() => createFormatters(locale, empty, justNow), [locale, empty, justNow]);
}
