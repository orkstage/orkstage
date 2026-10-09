import type { MetadataRoute } from 'next';
import { bilingualPages, languageAlternates, localePath, locales } from '@/lib/i18n';
import { landingSources, lastModified } from '@/lib/last-modified';
import { absoluteUrl } from '@/lib/shared';
import { source } from '@/lib/source';

export const dynamic = 'force-static';

/**
 * Every page of the export. Bilingual marketing pages list each locale with `xhtml:link`
 * alternates (en, pt-BR, x-default); docs are English only. `lastmod` comes from git (see
 * lib/last-modified.ts): the dictionary and components for the landing, the MDX file for a docs
 * page, the OpenAPI document for the generated API reference.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const marketing = bilingualPages.flatMap((path) => {
    const languages = Object.fromEntries(Object.entries(languageAlternates(path)).map(([k, v]) => [k, absoluteUrl(v)]));
    return locales.map((locale) => ({
      url: absoluteUrl(localePath(locale, path)),
      lastModified: lastModified(...landingSources[locale]),
      changeFrequency: 'weekly' as const,
      priority: 1,
      alternates: { languages },
    }));
  });

  const docs = source.getPages().map((page) => {
    const url = page.url.endsWith('/') ? page.url : `${page.url}/`;
    const generated = Boolean(page.data._openapi);
    return {
      url: absoluteUrl(url),
      lastModified: lastModified(generated ? 'openapi/orkstage.json' : `content/docs/${page.path}`),
      changeFrequency: 'weekly' as const,
      priority: url === '/docs/' ? 0.9 : generated ? 0.4 : 0.7,
    };
  });

  return [...marketing, ...docs];
}
