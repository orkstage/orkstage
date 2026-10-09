import type { ReactNode } from 'react';
import { pageMetadata } from '@/i18n/server';

/** Localized page title (the page itself is a client component). */
export const generateMetadata = () => pageMetadata('statusPage');

export default function StatusPageLayout({ children }: { children: ReactNode }) {
  return children;
}
