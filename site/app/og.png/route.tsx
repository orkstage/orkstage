import { renderOgImage } from '@/lib/og';

// English Open Graph card, exported once at build time to /og.png (the pt-BR card is /pt-br/og.png).
export const dynamic = 'force-static';

export function GET() {
  return renderOgImage('en');
}
