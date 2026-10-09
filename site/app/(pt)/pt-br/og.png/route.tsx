import { renderOgImage } from '@/lib/og';

// Brazilian Portuguese Open Graph card, exported once at build time to /pt-br/og.png.
export const dynamic = 'force-static';

export function GET() {
  return renderOgImage('pt-BR');
}
