import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { File, Files, Folder } from 'fumadocs-ui/components/files';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import type { ReactNode } from 'react';

/** Inline status label. `Preview` = built and usable, not yet released or still changing. */
export function Badge({ children, tone = 'preview' }: { children: ReactNode; tone?: 'preview' | 'planned' | 'ee' | 'simulated' }) {
  const tones = {
    preview: 'border-fd-primary/40 text-fd-primary',
    planned: 'border-fd-border text-fd-muted-foreground',
    ee: 'border-[#5aa9ff]/50 text-[#1a55ab] dark:text-[#5aa9ff]',
    simulated: 'border-[#ff6b00]/50 text-[#9a3e00] dark:text-[#ff6b00]',
  } as const;
  return (
    <span className={`not-prose ms-1 inline-flex items-center rounded-full border px-2 py-0.5 align-middle font-sans text-[11px] font-medium uppercase tracking-wide ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Accordion,
    Accordions,
    Badge,
    File,
    Files,
    Folder,
    Step,
    Steps,
    Tab,
    Tabs,
    TypeTable,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
