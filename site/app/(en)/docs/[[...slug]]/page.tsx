import { searchPath } from 'fumadocs-core/breadcrumb';
import type { Node } from 'fumadocs-core/page-tree';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { DocsBody, DocsDescription, DocsPage, DocsTitle, EditOnGitHub } from 'fumadocs-ui/layouts/docs/page';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ComponentProps } from 'react';
import { JsonLd } from '@/components/json-ld';
import { getMDXComponents } from '@/components/mdx';
import { OpenAPIPage } from '@/components/openapi-page';
import { lastModified } from '@/lib/last-modified';
import { openapi } from '@/lib/openapi';
import { docsJsonLd, docsPageMetadata, metaDescription } from '@/lib/seo';
import { editUrl } from '@/lib/shared';
import { source } from '@/lib/source';

type Params = { slug?: string[] };
type Page = NonNullable<ReturnType<typeof source.getPage>>;

function canonical(page: Page) {
  return page.url.endsWith('/') ? page.url : `${page.url}/`;
}

function isGenerated(page: Page) {
  return Boolean(page.data._openapi);
}

/** Title and meta description; generated API pages get an API suffix so they stay unique and long enough. */
function seo(page: Page) {
  const generated = isGenerated(page);
  const title = generated ? `${page.data.title} (API)` : page.data.title;
  const description = metaDescription(page.data.description, generated ? `${page.data.title} in the OrkStage Control API v1 reference.` : 'OrkStage documentation.');
  return { title, description };
}

function modified(page: Page) {
  return lastModified(isGenerated(page) ? 'openapi/orkstage.json' : `content/docs/${page.path}`);
}

/** Docs home, then each folder (linked to its index or first page) down to the page itself. */
function breadcrumbs(page: Page) {
  const crumbs = [{ name: 'OrkStage', url: '/' }, { name: 'Docs', url: '/docs/' }];
  const firstUrl = (node: Node): string | undefined => {
    if (node.type === 'page') return node.url;
    if (node.type === 'folder') return node.index?.url ?? node.children.map(firstUrl).find(Boolean);
    return undefined;
  };
  for (const node of searchPath(source.getPageTree().children, page.url) ?? []) {
    if (node.type !== 'folder') continue;
    const url = firstUrl(node);
    if (url && typeof node.name === 'string' && url !== page.url) crumbs.push({ name: node.name, url: url.endsWith('/') ? url : `${url}/` });
  }
  if (canonical(page) !== '/docs/') crumbs.push({ name: page.data.title, url: canonical(page) });
  return crumbs;
}

export default async function DocPage(props: { params: Promise<Params> }) {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  // Generated API reference pages carry `_openapi`; preload their document on the server.
  const preloaded = page.data._openapi ? await openapi.preloadOpenAPIPage(page) : undefined;
  const { description } = seo(page);

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <JsonLd data={docsJsonLd({ title: page.data.title, description, url: canonical(page), modified: modified(page), breadcrumbs: breadcrumbs(page) })} />
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-2">{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
            ...(preloaded
              ? { OpenAPIPage: (p: Omit<ComponentProps<typeof OpenAPIPage>, 'preloaded'>) => <OpenAPIPage {...(p as ComponentProps<typeof OpenAPIPage>)} {...preloaded} /> }
              : {}),
          })}
        />
      </DocsBody>
      <div className="mt-2 flex items-center border-t border-fd-border pt-4">
        <EditOnGitHub href={editUrl(page.path)} />
      </div>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const { title, description } = seo(page);
  return docsPageMetadata({ title, description, url: canonical(page), modified: modified(page) });
}
