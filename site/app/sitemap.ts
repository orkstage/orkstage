import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/shared';
import { source } from '@/lib/source';

export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  const docs = source.getPages().map((page) => ({
    url: `${siteUrl}${page.url.endsWith('/') ? page.url : `${page.url}/`}`,
    changeFrequency: 'weekly' as const,
    priority: page.url.includes('/api-reference/') ? 0.4 : 0.7,
  }));
  return [{ url: `${siteUrl}/`, changeFrequency: 'weekly', priority: 1 }, ...docs];
}
