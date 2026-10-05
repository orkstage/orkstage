import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { THEME_BOOTSTRAP } from '@/lib/theme';
import { Providers } from './providers';
import './globals.css';

const SLOGAN = 'Command every stage of your cloud.';
const DESCRIPTION = `${SLOGAN} OrkStage provisions, deploys and watches customer environments across AWS, Azure and OCI from one control plane.`;

export const metadata: Metadata = {
  applicationName: 'OrkStage',
  title: { default: `OrkStage — ${SLOGAN}`, template: '%s · OrkStage' },
  description: DESCRIPTION,
  robots: { index: false, follow: false },
  openGraph: {
    type: 'website',
    siteName: 'OrkStage',
    title: `OrkStage — ${SLOGAN}`,
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  colorScheme: 'dark light',
  themeColor: '#0D0E12',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // data-theme is set before paint by THEME_BOOTSTRAP; React must not fight it on hydration.
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
