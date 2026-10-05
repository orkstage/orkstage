'use client';

import { devLoginSchema } from '@co/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, KeyRound, ShieldCheck, Workflow, type LucideIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Button, buttonClass } from '@/components/ui/button';
import { Logo } from '@/components/brand/logo';
import { Card } from '@/components/ui/card';
import { ErrorNotice } from '@/components/ui/error-notice';
import { describedBy, Field, Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { API_BASE, apiGet, apiSend, asItems, isApiError, safeReturnTo } from '@/lib/api';
import { useMe } from '@/lib/ability';

interface AuthProvider {
  key: string;
  name: string;
}

const VALUE_POINTS: { icon: LucideIcon; title: string; detail: string }[] = [
  { icon: Workflow, title: 'Provision across AWS, Azure and OCI from one control plane', detail: 'Place each part of an environment on the account and region it belongs in.' },
  { icon: ShieldCheck, title: 'Every change planned, policy-checked and audited', detail: 'Preview the plan and estimated cost before anything touches your cloud.' },
  { icon: Activity, title: 'Health, incidents and status pages built in', detail: 'Watch every stage and keep customers informed without extra tooling.' },
];

const QUICK_PICKS = [
  { email: 'admin@example.local', label: 'Platform admin' },
  { email: 'operator@example.local', label: 'Platform operator' },
  { email: 'customer@example.local', label: 'Customer' },
];

export function LoginScreen() {
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

  const form = useForm({ resolver: zodResolver(devLoginSchema), defaultValues: { email: '' } });

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
        <Logo size="md" />
        <div className="max-w-xl space-y-6">
          <div className="space-y-3">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-accent-ink">Raw scale. Precise control.</p>
            <h1 id="brand-heading" className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em] sm:text-4xl">
              Command every stage of your cloud.
            </h1>
            <p className="max-w-md text-sm text-fg-muted">
              OrkStage turns templates into running customer environments, on any cloud, with every change planned before it happens.
            </p>
          </div>
          <ul className="space-y-3">
            {VALUE_POINTS.map(({ icon: Icon, title, detail }) => (
              <li key={title} className="flex gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-strong bg-surface-2 text-accent-ink">
                  <Icon size={14} aria-hidden />
                </span>
                <span>
                  <span className="block text-sm font-medium text-fg">{title}</span>
                  <span className="block text-xs text-fg-subtle">{detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-[11px] text-fg-subtle">Multi-cloud control plane for platform, SRE and DevOps teams.</p>
      </section>

      <div className="flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-5">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-[-0.01em]">Sign in</h2>
          <p className="text-xs text-fg-subtle">Use your organization's single sign-on.</p>
        </div>

        <Card className="space-y-4 p-5">
          <section aria-labelledby="sso-heading" className="space-y-2">
            <h3 id="sso-heading" className="text-sm font-medium">
              Single sign-on
            </h3>
            {providers.isLoading ? (
              <p className="flex items-center gap-2 text-xs text-fg-subtle">
                <Spinner size={12} /> Loading providers…
              </p>
            ) : ssoList.length === 0 ? (
              <p className="text-xs text-fg-subtle">{providers.isError ? 'Sign-in providers are unavailable right now.' : 'No SSO provider is configured.'}</p>
            ) : (
              <ul className="space-y-2">
                {ssoList.map((p) => (
                  <li key={p.key}>
                    <a
                      href={`${API_BASE}/auth/oidc/${encodeURIComponent(p.key)}/login?returnTo=${encodeURIComponent(returnTo)}`}
                      className={buttonClass('secondary', 'md', 'w-full')}
                    >
                      <KeyRound size={14} aria-hidden />
                      Continue with {p.name}
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
                  Development login
                </h3>
                <p className="text-xs text-fg-subtle">Local environments only. Disabled in production.</p>
              </div>
              <form onSubmit={onSubmit} className="space-y-3" noValidate>
                <Field label="Email" htmlFor="dev-email" error={emailError}>
                  <Input id="dev-email" type="email" autoComplete="email" placeholder="you@example.local" {...describedBy('dev-email', { error: emailError })} {...form.register('email')} />
                </Field>
                <Button type="submit" variant="primary" className="w-full" loading={login.isPending}>
                  Sign in
                </Button>
              </form>
              <div className="space-y-1.5">
                <p className="text-xs text-fg-subtle">Quick pick</p>
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
                      {q.label}
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
