import localFont from 'next/font/local';

/**
 * Self-hosted variable fonts (latin subset, which covers English and Portuguese). next/font
 * preloads them and generates a size-adjusted fallback, so text does not shift when the web
 * font arrives. The CSS variables feed `--font-sans` and `--font-display` in app/global.css.
 */
export const inter = localFont({
  src: '../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-inter',
  fallback: ['ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
});

export const spaceGrotesk = localFont({
  src: '../node_modules/@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2',
  weight: '300 700',
  style: 'normal',
  // Headings (the hero h1 is the largest text): no late swap, so the lines below never move.
  display: 'optional',
  variable: '--font-space-grotesk',
  fallback: ['ui-sans-serif', 'system-ui', 'sans-serif'],
});

export const fontVariables = `${inter.variable} ${spaceGrotesk.variable}`;
