import type { Metadata } from 'next';
import { getMessages, languageAlternates, type Locale, localeConfig, localePath, locales } from './i18n';
import { absoluteUrl, appName, links, siteUrl } from './shared';

/** Open Graph card per locale, rendered at build time (app/og.png, app/(pt)/pt-br/og.png). */
export const ogImage = { width: 1200, height: 630 } as const;
export function ogImagePath(locale: Locale): string {
  return `${localeConfig[locale].prefix}/og.png`;
}

const icons: Metadata['icons'] = {
  icon: [
    { url: '/brand/favicon-32.png', sizes: '32x32', type: 'image/png' },
    { url: '/brand/favicon-16.png', sizes: '16x16', type: 'image/png' },
    { url: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
  ],
  apple: [{ url: '/brand/apple-touch-icon.png', sizes: '180x180' }],
};

/** Defaults for a root layout. Every page overrides title, description and alternates. */
export function rootMetadata(locale: Locale): Metadata {
  const m = getMessages(locale);
  return {
    metadataBase: new URL(siteUrl),
    title: { default: m.meta.title, template: `%s | ${appName}` },
    description: m.meta.description,
    applicationName: appName,
    icons,
    formatDetection: { telephone: false, email: false, address: false },
    openGraph: { siteName: appName, locale: localeConfig[locale].ogLocale },
  };
}

/** Metadata of a marketing page that exists in every locale. */
export function bilingualPageMetadata(locale: Locale, opts: { title: string; description: string; path?: '/'; absoluteTitle?: boolean }): Metadata {
  const path = opts.path ?? '/';
  const url = localePath(locale, path);
  const image = { url: ogImagePath(locale), ...ogImage, alt: getMessages(locale).meta.ogImageAlt, type: 'image/png' };
  return {
    title: opts.absoluteTitle ? { absolute: opts.title } : opts.title,
    description: opts.description,
    alternates: { canonical: url, languages: languageAlternates(path) },
    openGraph: {
      type: 'website',
      siteName: appName,
      url,
      title: opts.title,
      description: opts.description,
      locale: localeConfig[locale].ogLocale,
      alternateLocale: locales.filter((l) => l !== locale).map((l) => localeConfig[l].ogLocale),
      images: [image],
    },
    twitter: { card: 'summary_large_image', title: opts.title, description: opts.description, images: [image] },
  };
}

/** Metadata of an English-only docs page. */
export function docsPageMetadata(opts: { title: string; description: string; url: string; modified?: string }): Metadata {
  const image = { url: ogImagePath('en'), ...ogImage, alt: getMessages('en').meta.ogImageAlt, type: 'image/png' };
  const fullTitle = `${opts.title} | ${appName}`;
  return {
    title: opts.title,
    description: opts.description,
    alternates: { canonical: opts.url, languages: { en: opts.url, 'x-default': opts.url } },
    openGraph: {
      type: 'article',
      siteName: appName,
      url: opts.url,
      title: fullTitle,
      description: opts.description,
      locale: localeConfig.en.ogLocale,
      images: [image],
      ...(opts.modified ? { modifiedTime: opts.modified } : {}),
    },
    twitter: { card: 'summary_large_image', title: fullTitle, description: opts.description, images: [image] },
  };
}

/** Meta descriptions between roughly 70 and 160 characters, cut at a word boundary. */
export function metaDescription(text: string | undefined, fallback: string): string {
  let d = (text ?? '').replace(/\s+/g, ' ').trim();
  if (d.length < 70) d = d ? `${d.replace(/\.?$/, '.')} ${fallback}` : fallback;
  if (d.length <= 160) return d;
  // Whole sentences when they fit, otherwise a cut at a word boundary (no ellipsis).
  let out = '';
  for (const sentence of d.match(/[^.!?]+[.!?]+(\s|$)/g) ?? []) {
    if ((out + sentence).trim().length > 160) break;
    out += sentence;
  }
  if (out.trim().length >= 70) return out.trim();
  const cut = d.slice(0, 159);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,.;:]$/, '')}.`;
}

/* JSON-LD */

const organizationId = `${siteUrl}/#organization`;
const websiteId = `${siteUrl}/#website`;
const softwareId = `${siteUrl}/#software`;

function organization() {
  return {
    '@type': 'Organization',
    '@id': organizationId,
    name: appName,
    url: `${siteUrl}/`,
    logo: { '@type': 'ImageObject', url: absoluteUrl('/brand/icon-512.png'), width: 512, height: 512 },
    sameAs: [links.githubOrg, links.github],
  };
}

function website() {
  return {
    '@type': 'WebSite',
    '@id': websiteId,
    name: appName,
    url: `${siteUrl}/`,
    inLanguage: locales.map((l) => localeConfig[l].htmlLang),
    publisher: { '@id': organizationId },
  };
}

/** Organization, WebSite, the product (SoftwareApplication) and its code (SoftwareSourceCode). */
export function landingJsonLd(locale: Locale) {
  const m = getMessages(locale);
  const url = absoluteUrl(localePath(locale, '/'));
  return {
    '@context': 'https://schema.org',
    '@graph': [
      organization(),
      website(),
      {
        '@type': 'WebPage',
        '@id': `${url}#webpage`,
        url,
        name: m.meta.title,
        description: m.meta.description,
        inLanguage: localeConfig[locale].htmlLang,
        isPartOf: { '@id': websiteId },
        about: { '@id': softwareId },
        primaryImageOfPage: absoluteUrl(ogImagePath(locale)),
      },
      {
        '@type': 'SoftwareApplication',
        '@id': softwareId,
        name: appName,
        description: m.meta.description,
        url: `${siteUrl}/`,
        applicationCategory: 'DeveloperApplication',
        applicationSubCategory: 'Cloud infrastructure management',
        operatingSystem: 'Linux, Docker',
        license: 'https://www.gnu.org/licenses/agpl-3.0.html',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', description: 'Community edition (AGPL-3.0)' },
        publisher: { '@id': organizationId },
        softwareHelp: { '@type': 'CreativeWork', url: absoluteUrl(links.docs) },
        image: absoluteUrl(ogImagePath(locale)),
      },
      {
        '@type': 'SoftwareSourceCode',
        name: appName,
        codeRepository: links.github,
        programmingLanguage: ['TypeScript', 'Rust', 'HCL'],
        license: 'https://www.gnu.org/licenses/agpl-3.0.html',
        targetProduct: { '@id': softwareId },
        author: { '@id': organizationId },
      },
    ],
  };
}

/** TechArticle and BreadcrumbList for a docs page. */
export function docsJsonLd(opts: { title: string; description: string; url: string; modified?: string; breadcrumbs: { name: string; url: string }[] }) {
  const url = absoluteUrl(opts.url);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        '@id': `${url}#article`,
        headline: opts.title,
        description: opts.description,
        url,
        mainEntityOfPage: url,
        inLanguage: 'en',
        image: absoluteUrl(ogImagePath('en')),
        ...(opts.modified ? { dateModified: opts.modified } : {}),
        author: { '@id': organizationId },
        publisher: organization(),
        isPartOf: { '@type': 'WebSite', '@id': websiteId, name: appName, url: `${siteUrl}/` },
        about: { '@type': 'SoftwareApplication', '@id': softwareId, name: appName },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: opts.breadcrumbs.map((b, i) => ({ '@type': 'ListItem', position: i + 1, name: b.name, item: absoluteUrl(b.url) })),
      },
    ],
  };
}
