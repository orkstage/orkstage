import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';

// Open Graph card rendered once at build time to /og.png (1200x630).
export const dynamic = 'force-static';

export function GET() {
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
            'linear-gradient(to right, rgba(232,234,240,0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(232,234,240,0.05) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
          color: '#e8eaf0',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logo} width={462} height={130} alt="OrkStage" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ fontSize: 68, fontWeight: 700, letterSpacing: -2, lineHeight: 1.05 }}>Command every stage of your cloud.</div>
          <div style={{ fontSize: 30, color: '#a3a9b8' }}>Open-source multi-cloud control plane. Template, plan, deploy, operate.</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 24, color: '#a3a9b8', borderTop: '1px solid #262a35', paddingTop: 22 }}>
          <span style={{ color: '#00f29b' }}>orkstage.io</span>
          <span>AWS · Azure · OCI — Raw scale. Precise control.</span>
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
