import { HomePage } from '@/components/landing/home-page';
import { getMessages } from '@/lib/i18n';
import { bilingualPageMetadata } from '@/lib/seo';

const m = getMessages('pt-BR');

export const metadata = bilingualPageMetadata('pt-BR', { title: m.meta.title, description: m.meta.description, absoluteTitle: true });

export default function Page() {
  return <HomePage locale="pt-BR" />;
}
