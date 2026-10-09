import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { messagesFor } from '@/i18n/messages';
import { getLocale, getTranslator } from '@/i18n/server';
import { THEME_BOOTSTRAP } from '@/lib/theme';
import { Providers } from './providers';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  const title = t('meta.defaultTitle');
  const description = t('meta.description');
  return {
    applicationName: 'OrkStage',
    title: { default: title, template: '%s · OrkStage' },
    description,
    // The console is a private app: no page is ever indexed or followed.
    robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
    openGraph: { type: 'website', siteName: 'OrkStage', title, description },
  };
}

export const viewport: Viewport = {
  colorScheme: 'dark light',
  themeColor: '#0D0E12',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    // data-theme is set before paint by THEME_BOOTSTRAP; React must not fight it on hydration.
    <html lang={locale} data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <Providers locale={locale} messages={messagesFor(locale)}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
