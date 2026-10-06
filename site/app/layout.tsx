import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import './global.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { appName, siteDescription, siteUrl, slogan } from '@/lib/shared';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: `${appName}: ${slogan}`,
    template: `%s | ${appName}`,
  },
  description: siteDescription,
  applicationName: appName,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: appName,
    url: siteUrl,
    title: `${appName}: ${slogan}`,
    description: siteDescription,
    images: [{ url: '/og.png', width: 1200, height: 630, alt: `${appName}: ${slogan}` }],
  },
  twitter: {
    card: 'summary_large_image',
    title: `${appName}: ${slogan}`,
    description: siteDescription,
    images: ['/og.png'],
  },
  icons: {
    icon: [
      { url: '/brand/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/brand/favicon-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/brand/apple-touch-icon.png', sizes: '180x180' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#0d0e12',
  colorScheme: 'dark light',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col bg-fd-background text-fd-foreground">{children}</body>
    </html>
  );
}
