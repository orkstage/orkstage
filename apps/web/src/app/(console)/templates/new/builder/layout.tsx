import type { ReactNode } from 'react';
import { pageMetadata } from '@/i18n/server';

/** Localized page title (the page itself is a client component). */
export const generateMetadata = () => pageMetadata('templateBuilder');

export default function NewTemplateBuilderLayout({ children }: { children: ReactNode }) {
  return children;
}
