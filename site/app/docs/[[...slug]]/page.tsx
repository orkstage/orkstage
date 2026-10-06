import { createRelativeLink } from 'fumadocs-ui/mdx';
import { DocsBody, DocsDescription, DocsPage, DocsTitle, EditOnGitHub } from 'fumadocs-ui/layouts/docs/page';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ComponentProps } from 'react';
import { getMDXComponents } from '@/components/mdx';
import { OpenAPIPage } from '@/components/openapi-page';
import { openapi } from '@/lib/openapi';
import { appName, editUrl } from '@/lib/shared';
import { source } from '@/lib/source';

type Params = { slug?: string[] };

export default async function Page(props: { params: Promise<Params> }) {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  // Generated API reference pages carry `_openapi`; preload their document on the server.
  const preloaded = page.data._openapi ? await openapi.preloadOpenAPIPage(page) : undefined;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
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
  const canonical = page.url.endsWith('/') ? page.url : `${page.url}/`;
  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical },
    openGraph: {
      type: 'article',
      title: `${page.data.title} | ${appName} docs`,
      description: page.data.description,
      url: canonical,
      images: [{ url: '/og.png', width: 1200, height: 630 }],
    },
  };
}
