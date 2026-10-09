/**
 * Locales of the marketing pages. English is the default and lives at the root (`/`); Brazilian
 * Portuguese lives under `/pt-br/`. Path based on purpose: the site is a static export on S3 +
 * CloudFront, so there is no middleware and no server redirect by language. The documentation
 * (`/docs/**`) is English only.
 */
export const locales = ['en', 'pt-BR'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'en';

export const localeConfig = {
  en: { prefix: '', htmlLang: 'en', ogLocale: 'en_US', short: 'EN', name: 'English' },
  'pt-BR': { prefix: '/pt-br', htmlLang: 'pt-BR', ogLocale: 'pt_BR', short: 'PT-BR', name: 'Português (Brasil)' },
} as const satisfies Record<Locale, { prefix: string; htmlLang: string; ogLocale: string; short: string; name: string }>;

/**
 * Marketing pages that exist in every locale, as paths relative to the locale root. The sitemap,
 * the hreflang alternates and the language switcher all read this list.
 */
export const bilingualPages = ['/'] as const;
export type BilingualPage = (typeof bilingualPages)[number];

/** `/` in pt-BR is `/pt-br/`; every path ends with a slash (trailingSlash export). */
export function localePath(locale: Locale, path: BilingualPage | string = '/'): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  const withSlash = clean.endsWith('/') ? clean : `${clean}/`;
  return `${localeConfig[locale].prefix}${withSlash}`;
}

/** hreflang map for a bilingual page: every locale plus `x-default` (English). */
export function languageAlternates(path: BilingualPage): Record<string, string> {
  const map: Record<string, string> = {};
  for (const locale of locales) map[localeConfig[locale].htmlLang] = localePath(locale, path);
  map['x-default'] = localePath(defaultLocale, path);
  return map;
}
