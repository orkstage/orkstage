import type { Viewport } from 'next';
import type { ReactNode } from 'react';
import { fontVariables } from '@/lib/fonts';

export const viewport: Viewport = {
  themeColor: '#0d0e12',
  colorScheme: 'dark light',
};

/**
 * `<html>` and `<body>` for a root layout. Each locale has its own root layout (route groups
 * `(en)` and `(pt)`) so `lang` is right in the static HTML, without client code.
 */
export function RootHtml({ lang, children }: { lang: string; children: ReactNode }) {
  return (
    <html lang={lang} className={fontVariables} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col bg-fd-background text-fd-foreground">{children}</body>
    </html>
  );
}
