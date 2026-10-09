import '../global.css';
import type { ReactNode } from 'react';
import { RootHtml } from '@/components/site/root-html';
import { rootMetadata } from '@/lib/seo';

export { viewport } from '@/components/site/root-html';

/** Root layout for Brazilian Portuguese: the marketing pages under `/pt-br/`. */
export const metadata = rootMetadata('pt-BR');

export default function PortugueseLayout({ children }: { children: ReactNode }) {
  return <RootHtml lang="pt-BR">{children}</RootHtml>;
}
