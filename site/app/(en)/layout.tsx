import '../global.css';
import type { ReactNode } from 'react';
import { RootHtml } from '@/components/site/root-html';
import { rootMetadata } from '@/lib/seo';

export { viewport } from '@/components/site/root-html';

/** Root layout for English: the landing page at `/` and the documentation under `/docs/`. */
export const metadata = rootMetadata('en');

export default function EnglishLayout({ children }: { children: ReactNode }) {
  return <RootHtml lang="en">{children}</RootHtml>;
}
