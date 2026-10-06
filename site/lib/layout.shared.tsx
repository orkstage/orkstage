import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { Logo } from '@/components/logo';
import { links } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <Logo height={28} />,
      url: '/',
    },
    githubUrl: links.github,
    links: [
      { text: 'Home', url: '/', active: 'url' },
      { text: 'Docs', url: '/docs/', active: 'nested-url' },
    ],
  };
}
