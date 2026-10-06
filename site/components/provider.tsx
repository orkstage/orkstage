'use client';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';
import SearchDialog from '@/components/search';

/** Docs-only provider: theme switching (dark default, light optional) and the static search. */
export function Provider({ children }: { children: ReactNode }) {
  return (
    <RootProvider search={{ SearchDialog }} theme={{ defaultTheme: 'dark', enableSystem: false }}>
      {children}
    </RootProvider>
  );
}
