/* eslint-disable @next/next/no-img-element -- static brand assets, pre-sized in /public/brand */
import { cn } from '@/lib/utils';

/**
 * Official OrkStage brand kit v4: flat vector artwork (no glow or shadow), tightly cropped SVGs in
 * /public/brand. Full logo in navigation and headers, mark alone in compact spots; never recolor,
 * stretch or add effects. Dark-surface artwork is the default; the light variant shows when the
 * console runs in the light theme (see .brand-on-* in globals.css).
 */
const LOGO_RATIO = 1181.85 / 333;
const MARK_RATIO = 338 / 333;

/** Artwork height in px (the SVGs have no built-in padding). */
const HEIGHTS = { sm: 28, md: 34, lg: 44, xl: 60 } as const;
const MARK_HEIGHTS = { sm: 24, md: 32, lg: 44, xl: 60 } as const;

function Themed({ base, height, ratio, alt }: { base: 'logo' | 'mark'; height: number; ratio: number; alt: string }) {
  const width = Math.round(height * ratio);
  return (
    <>
      <img src={`/brand/${base}-dark.svg`} alt={alt} width={width} height={height} className="brand-on-dark" decoding="async" />
      <img src={`/brand/${base}-light.svg`} alt={alt} width={width} height={height} className="brand-on-light" decoding="async" />
    </>
  );
}

export function LogoMark({ size = 24, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <span className={cn('inline-flex shrink-0', className)}>
      <Themed base="mark" height={size} ratio={MARK_RATIO} alt={title ?? ''} />
    </span>
  );
}

/** `variant="mark"` renders the symbol only (collapsed sidebar / mobile header). */
export function Logo({ size = 'md', variant = 'full', className }: { size?: keyof typeof HEIGHTS; variant?: 'full' | 'mark'; className?: string }) {
  const h = HEIGHTS[size];
  if (variant === 'mark') return <LogoMark size={MARK_HEIGHTS[size]} title="OrkStage" className={className} />;
  return (
    <span className={cn('inline-flex shrink-0 items-center', className)}>
      <Themed base="logo" height={h} ratio={LOGO_RATIO} alt="OrkStage" />
    </span>
  );
}
