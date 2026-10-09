import Link from 'next/link';
import { Logo } from '@/components/brand/logo';
import { buttonClass } from '@/components/ui/button';
import { getTranslator, pageMetadata } from '@/i18n/server';

export const generateMetadata = async () => ({ ...(await pageMetadata('notFound')), robots: { index: false, follow: false } });

export default async function NotFound() {
  const t = await getTranslator();
  return (
    <main className="bg-grid flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <Logo size="md" />
      <p className="font-mono text-xs text-fg-subtle">404</p>
      <h1 className="font-display text-xl font-semibold">{t('notFound.title')}</h1>
      <p className="max-w-sm text-sm text-fg-muted">{t('notFound.body')}</p>
      <Link href="/" className={buttonClass('secondary', 'md')}>
        {t('notFound.back')}
      </Link>
    </main>
  );
}
