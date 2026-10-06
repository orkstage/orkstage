import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '@/lib/source';

// Exported once at build time as /search.json (Orama index) for the client-side search.
export const revalidate = false;
export const dynamic = 'force-static';

export const { staticGET: GET } = createFromSource(source, {
  language: 'english',
});
