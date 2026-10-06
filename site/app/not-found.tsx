import Link from 'next/link';
import { Logo } from '@/components/logo';

export default function NotFound() {
  return (
    <main className="bg-grid flex min-h-screen flex-1 flex-col items-center justify-center gap-6 bg-obsidian px-4 text-center text-ink">
      <Logo height={44} forceDark />
      <h1 className="font-display text-3xl font-semibold tracking-tight">This stage does not exist.</h1>
      <p className="max-w-md text-ink-muted">The page moved or never existed. Start from the documentation or the home page.</p>
      <div className="flex gap-3">
        <Link href="/docs/" className="rounded-md bg-mint px-4 py-2 font-medium text-obsidian">
          Documentation
        </Link>
        <Link href="/" className="rounded-md border border-hairline-strong px-4 py-2 font-medium text-ink">
          Home
        </Link>
      </div>
    </main>
  );
}
