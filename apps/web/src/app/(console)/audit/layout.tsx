import type { ReactNode } from 'react';
import { pageMetadata } from '@/i18n/server';

/** Localized page title (the page itself is a client component). */
export const generateMetadata = () => pageMetadata('audit');

export default function AuditLayout({ children }: { children: ReactNode }) {
  return children;
}
