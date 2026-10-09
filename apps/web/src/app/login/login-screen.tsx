'use client';

import { devLoginSchema } from '@co/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, KeyRound, ShieldCheck, Workflow, type LucideIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'use-intl';
import { LanguageSelect } from '@/components/language-switcher';
import { Button, buttonClass } from '@/components/ui/button';
import { Logo } from '@/components/brand/logo';
import { Card } from '@/components/ui/card';
import { ErrorNotice } from '@/components/ui/error-notice';
import { describedBy, Field, Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { API_BASE, apiGet, apiSend, asItems, isApiError, safeReturnTo } from '@/lib/api';
import { useZodResolver } from '@/i18n/zod';
import { useMe } from '@/lib/ability';

interface AuthProvider {
  key: string;
  name: string;
}

const VALUE_POINTS: { icon: LucideIcon; key: 'provision' | 'plan' | 'health' }[] = [
  { icon: Workflow, key: 'provision' },
  { icon: ShieldCheck, key: 'plan' },
  { icon: Activity, key: 'health' },
];

const QUICK_PICKS = [
  { email: 'admin@example.local', label: 'platformAdmin' },
  { email: 'operator@example.local', label: 'platformOperator' },
  { email: 'customer@example.local', label: 'customer' },
] as const;

export function LoginScreen() {
  const t = useTranslations('login');
  const router = useRouter();
  const params = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const queryClient = useQueryClient();

  // Already signed in? Skip the form.
  const me = useMe();
  useEffect(() => {
    if (me.data) router.replace(returnTo);
  }, [me.data, returnTo, router]);

  const providers = useQuery({
    queryKey: ['auth-providers'],
    queryFn: async ({ signal }) => asItems(await apiGet<AuthProvider[] | { items: AuthProvider[] }>('/auth/providers', { signal })),
    retry: false,
  });

  // Dev login is local-only: the API answers 404 when it is disabled. Probe with an empty body
  // (a validation error proves the endpoint exists) so the form is hidden up front.
  const devAvailable = useQuery({
    queryKey: ['dev-login-available'],
    queryFn: async () => {
      try {
        await apiSend('POST', '/auth/dev-login', {});
        return true;
      } catch (err) {
        return !isApiError(err, 404);
      }
    },
    retry: false,
    staleTime: Infinity,
  });

  const form = useForm({ resolver: useZodResolver(devLoginSchema), defaultValues: { email: '' } });

  const login = useMutation({
    mutationFn: (email: string) => apiSend<unknown>('POST', '/auth/dev-login', { email }),
    onSuccess: () => {
      queryClient.clear();
      router.replace(returnTo);
    },
    onError: (err) => {
      if (isApiError(err, 404)) queryClient.setQueryData(['dev-login-available'], false);
    },
  });

  const onSubmit = form.handleSubmit((values) => login.mutate(values.email));
  const emailError = form.formState.errors.email?.message;
  const ssoList = providers.data ?? [];

  return (
    <main className="grid min-h-dvh lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <section aria-labelledby="brand-heading" className="bg-grid relative flex flex-col justify-between gap-10 border-b border-border bg-surface px-6 py-8 sm:px-10 lg:border-b-0 lg:border-r lg:py-12">
        <div className="flex items-center justify-between gap-3">
          <Logo size="md" />
          <LanguageSelect />
        </div>
        <div className="max-w-xl space-y-6">
          <div className="space-y-3">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-accent-ink">{t('tagline')}</p>
            <h1 id="brand-heading" className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em] sm:text-4xl">
              {t('headline')}
            </h1>
            <p className="max-w-md text-sm text-fg-muted">{t('intro')}</p>
          </div>
          <ul className="space-y-3">
            {VALUE_POINTS.map(({ icon: Icon, key }) => (
              <li key={key} className="flex gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-strong bg-surface-2 text-accent-ink">
                  <Icon size={14} aria-hidden />
                </span>
                <span>
                  <span className="block text-sm font-medium text-fg">{t(`points.${key}Title`)}</span>
                  <span className="block text-xs text-fg-subtle">{t(`points.${key}Detail`)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-[11px] text-fg-subtle">{t('footer')}</p>
      </section>

      <div className="flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-5">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-[-0.01em]">{t('title')}</h2>
          <p className="text-xs text-fg-subtle">{t('subtitle')}</p>
        </div>

        <Card className="space-y-4 p-5">
          <section aria-labelledby="sso-heading" className="space-y-2">
            <h3 id="sso-heading" className="text-sm font-medium">
              {t('sso')}
            </h3>
            {providers.isLoading ? (
              <p className="flex items-center gap-2 text-xs text-fg-subtle">
                <Spinner size={12} /> {t('loadingProviders')}
              </p>
            ) : ssoList.length === 0 ? (
              <p className="text-xs text-fg-subtle">{providers.isError ? t('providersUnavailable') : t('noProviders')}</p>
            ) : (
              <ul className="space-y-2">
                {ssoList.map((p) => (
                  <li key={p.key}>
                    <a
                      href={`${API_BASE}/auth/oidc/${encodeURIComponent(p.key)}/login?returnTo=${encodeURIComponent(returnTo)}`}
                      className={buttonClass('secondary', 'md', 'w-full')}
                    >
                      <KeyRound size={14} aria-hidden />
                      {t('continueWith', { name: p.name })}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {devAvailable.data !== false ? (
            <section aria-labelledby="dev-heading" className="space-y-3 border-t border-border pt-4">
              <div>
                <h3 id="dev-heading" className="text-sm font-medium">
                  {t('dev.title')}
                </h3>
                <p className="text-xs text-fg-subtle">{t('dev.hint')}</p>
              </div>
              <form onSubmit={onSubmit} className="space-y-3" noValidate>
                <Field label={t('dev.email')} htmlFor="dev-email" error={emailError}>
                  <Input id="dev-email" type="email" autoComplete="email" placeholder="you@example.local" {...describedBy('dev-email', { error: emailError })} {...form.register('email')} />
                </Field>
                <Button type="submit" variant="primary" className="w-full" loading={login.isPending}>
                  {t('dev.submit')}
                </Button>
              </form>
              <div className="space-y-1.5">
                <p className="text-xs text-fg-subtle">{t('dev.quickPick')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {QUICK_PICKS.map((q) => (
                    <Button
                      key={q.email}
                      size="sm"
                      variant="secondary"
                      disabled={login.isPending}
                      onClick={() => {
                        form.setValue('email', q.email);
                        login.mutate(q.email);
                      }}
                      title={q.email}
                    >
                      {t(`dev.${q.label}`)}
                    </Button>
                  ))}
                </div>
              </div>
              {login.error ? <ErrorNotice error={login.error} /> : null}
            </section>
          ) : null}
        </Card>
      </div>
      </div>
    </main>
  );
}
