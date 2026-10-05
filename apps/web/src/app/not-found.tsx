import Link from 'next/link';
import { Logo } from '@/components/brand/logo';
import { buttonClass } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="bg-grid flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <Logo size="md" />
      <p className="font-mono text-xs text-fg-subtle">404</p>
      <h1 className="font-display text-xl font-semibold">This page is not on any stage</h1>
      <p className="max-w-sm text-sm text-fg-muted">The address may be mistyped, or the page was moved. Check the link or head back to the console.</p>
      <Link href="/" className={buttonClass('secondary', 'md')}>
        Back to OrkStage
      </Link>
    </main>
  );
}
