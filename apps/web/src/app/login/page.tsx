import { Suspense } from 'react';
import { PageSpinner } from '@/components/ui/spinner';
import { pageMetadata } from '@/i18n/server';
import { LoginScreen } from './login-screen';

export const generateMetadata = () => pageMetadata('signIn');

export default function LoginPage() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <LoginScreen />
    </Suspense>
  );
}
