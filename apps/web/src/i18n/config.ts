/**
 * Console languages. English is the default; Brazilian Portuguese is the second language.
 * There is no locale in URLs (the console is an authenticated app): the choice lives in the
 * NEXT_LOCALE cookie, and without a cookie the browser's Accept-Language decides.
 */
export const LOCALES = ['en', 'pt-BR'] as const;
export type AppLocale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = 'en';
export const LOCALE_COOKIE = 'NEXT_LOCALE';
/** One year: the choice is a UI preference, not a session. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Language names are shown in their own language, as switchers usually do. */
export const LOCALE_NAMES: Record<AppLocale, string> = {
  en: 'English',
  'pt-BR': 'Português (Brasil)',
};

export function isLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Picks the console language from an Accept-Language header: the highest-weighted language that
 * is Portuguese (any region) or English wins; anything else falls back to English.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): AppLocale {
  if (!header) return DEFAULT_LOCALE;
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((l) => l.tag && l.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const { tag } of ranked) {
    if (tag === 'pt' || tag.startsWith('pt-')) return 'pt-BR';
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return DEFAULT_LOCALE;
}
