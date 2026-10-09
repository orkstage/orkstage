import { HomePage } from '@/components/landing/home-page';
import { getMessages } from '@/lib/i18n';
import { bilingualPageMetadata } from '@/lib/seo';

const m = getMessages('en');

export const metadata = bilingualPageMetadata('en', { title: m.meta.title, description: m.meta.description, absoluteTitle: true });

export default function Page() {
  return <HomePage locale="en" />;
}
