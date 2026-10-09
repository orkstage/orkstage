import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { pageMetadata } from '@/i18n/server';

/** The overview ("/") title; every other console route sets its own in its layout. */
export const generateMetadata = () => pageMetadata('overview');

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
