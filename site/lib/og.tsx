import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { getMessages, type Locale } from './i18n';
import { ogImage } from './seo';

/**
 * Open Graph card (1200x630) for one locale, rendered once at build time. Brand colors only:
 * obsidian #0D0E12 background, metallic #E2E8F0 text, Acid Mint #00F29B for the domain. The logo
 * is the official PNG export (assets/brand/logo-dark.png), placed as is.
 */
export function renderOgImage(locale: Locale) {
  const m = getMessages(locale).og;
  const logo = `data:image/png;base64,${readFileSync(join(process.cwd(), 'assets/brand/logo-dark.png')).toString('base64')}`;
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '64px 72px',
          backgroundColor: '#0d0e12',
          backgroundImage:
            'linear-gradient(to right, rgba(226,232,240,0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(226,232,240,0.05) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
          color: '#e2e8f0',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logo} width={462} height={130} alt="OrkStage" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ fontSize: 68, fontWeight: 700, letterSpacing: -2, lineHeight: 1.05 }}>{m.headline}</div>
          <div style={{ fontSize: 30, color: '#a3a9b8' }}>{m.subline}</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 24, color: '#a3a9b8', borderTop: '1px solid #262a35', paddingTop: 22 }}>
          <span style={{ color: '#00f29b' }}>{locale === 'en' ? 'orkstage.io' : 'orkstage.io/pt-br'}</span>
          <span>{m.footer}</span>
        </div>
      </div>
    ),
    { ...ogImage },
  );
}
