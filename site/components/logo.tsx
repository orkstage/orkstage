/* eslint-disable @next/next/no-img-element -- static brand assets, pre-sized in /public/brand */

/**
 * Official OrkStage brand kit v4 (flat vector SVGs in /public/brand, tightly cropped). Same usage
 * as the console (apps/web/src/components/brand/logo.tsx): the complete logo in navigation and
 * headers, the mark alone in compact spots; never recolored, stretched or given effects. The
 * dark-surface artwork is the default; the light variant shows when the docs run in light theme.
 */
const LOGO_RATIO = 1181.85 / 333;
const MARK_RATIO = 338 / 333;

function Themed({ base, height, ratio, alt, forceDark }: { base: 'logo' | 'mark'; height: number; ratio: number; alt: string; forceDark?: boolean }) {
  const width = Math.round(height * ratio);
  if (forceDark) return <img src={`/brand/${base}-dark.svg`} alt={alt} width={width} height={height} decoding="async" className="max-w-none" />;
  return (
    <>
      <img src={`/brand/${base}-dark.svg`} alt={alt} width={width} height={height} className="brand-on-dark" decoding="async" />
      <img src={`/brand/${base}-light.svg`} alt={alt} width={width} height={height} className="brand-on-light" decoding="async" />
    </>
  );
}

/** Complete logo. `forceDark` for surfaces that are always dark (the landing page). */
export function Logo({ height = 32, forceDark, className, alt = 'OrkStage' }: { height?: number; forceDark?: boolean; className?: string; alt?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center ${className ?? ''}`}>
      <Themed base="logo" height={height} ratio={LOGO_RATIO} alt={alt} forceDark={forceDark} />
    </span>
  );
}

export function LogoMark({ height = 24, title, forceDark }: { height?: number; title?: string; forceDark?: boolean }) {
  return (
    <span className="inline-flex shrink-0">
      <Themed base="mark" height={height} ratio={MARK_RATIO} alt={title ?? ''} forceDark={forceDark} />
    </span>
  );
}
