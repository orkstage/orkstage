import { cn } from '@/lib/utils';

/**
 * OrkStage mark: a faceted hexagonal "O" built from two heavy chevrons (scale, force) framing a
 * single level bar (the stage). Straight paths only, so it stays crisp at 16px.
 * Chevrons use the accent; the stage bar uses the foreground ink.
 */
export function LogoMark({ size = 24, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn('shrink-0', className)}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path d="M12 1.5 21.5 7v3.4L12 4.9 2.5 10.4V7z" fill="var(--accent)" />
      <path d="M2.5 13.6 12 19.1l9.5-5.5V17L12 22.5 2.5 17z" fill="var(--accent)" />
      <path d="M6.5 10.9h11v2.2h-11z" fill="var(--fg)" />
    </svg>
  );
}

const SIZES = {
  sm: { mark: 18, text: 'text-[15px]' },
  md: { mark: 22, text: 'text-lg' },
  lg: { mark: 30, text: 'text-2xl' },
  xl: { mark: 40, text: 'text-4xl' },
} as const;

/**
 * Wordmark. `variant="mark"` renders the glyph only (collapsed sidebar / mobile header); the
 * accessible name is always "OrkStage".
 */
export function Logo({ size = 'md', variant = 'full', className }: { size?: keyof typeof SIZES; variant?: 'full' | 'mark'; className?: string }) {
  const s = SIZES[size];
  if (variant === 'mark') return <LogoMark size={s.mark} title="OrkStage" className={className} />;
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <LogoMark size={s.mark} />
      <span className={cn('font-display font-semibold leading-none tracking-[-0.02em] text-fg', s.text)}>
        Ork<span className="font-medium">Stage</span>
      </span>
    </span>
  );
}
