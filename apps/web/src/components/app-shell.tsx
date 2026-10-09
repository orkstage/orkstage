'use client';

import type { MeResponse } from '@co/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AppWindow,
  Boxes,
  Building2,
  Cloud,
  FileCode2,
  Gauge,
  LogOut,
  Menu,
  Rocket,
  ScrollText,
  Moon,
  Plug,
  Sun,
  Siren,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { apiSend, isApiError } from '@/lib/api';
import { isPlatformStaff, useMe } from '@/lib/ability';
import { useDismiss } from '@/lib/hooks';
import { setTheme, useTheme } from '@/lib/theme';
import type { Messages } from '@/i18n/messages';
import { cn } from '@/lib/utils';
import { Logo } from './brand/logo';
import { NotificationsBell } from './notifications-bell';
import { Button } from './ui/button';
import { ErrorNotice } from './ui/error-notice';
import { PageSpinner } from './ui/spinner';
import { EditionBadge } from './edition-badge';
import { LanguageMenuGroup } from './language-switcher';

type NavKey = keyof Messages['shell']['nav'];

interface NavItem {
  href: string;
  label: Exclude<NavKey, 'label'>;
  icon: LucideIcon;
  /** Extra path prefixes that mark this item active. */
  match?: string[];
}

function navFor(me: MeResponse): NavItem[] {
  if (isPlatformStaff(me)) {
    return [
      { href: '/', label: 'overview', icon: Gauge },
      { href: '/tenants', label: 'tenants', icon: Building2 },
      { href: '/instances', label: 'instances', icon: Boxes },
      { href: '/deployments', label: 'deployments', icon: Rocket },
      { href: '/templates', label: 'templates', icon: FileCode2 },
      { href: '/applications', label: 'applications', icon: AppWindow },
      { href: '/cloud-targets', label: 'cloudTargets', icon: Cloud },
      { href: '/incidents', label: 'incidents', icon: Siren },
      { href: '/audit', label: 'audit', icon: ScrollText },
      { href: '/settings/integrations', label: 'integrations', icon: Plug },
    ];
  }
  const first = me.memberships[0]?.tenantId;
  const items: NavItem[] = [
    { href: '/', label: 'overview', icon: Gauge },
    { href: '/instances', label: 'instances', icon: Boxes },
    { href: '/deployments', label: 'deployments', icon: Rocket },
    { href: '/incidents', label: 'incidents', icon: Siren },
  ];
  if (first) items.push({ href: `/status/${first}`, label: 'statusPage', icon: Activity, match: ['/status'] });
  if (me.memberships.some((m) => m.role === 'CustomerOwner' || m.role === 'CustomerAdmin')) {
    items.push({ href: '/settings/integrations', label: 'integrations', icon: Plug });
  }
  return items;
}

function isActive(pathname: string, item: NavItem): boolean {
  if (item.href === '/') return pathname === '/';
  const prefixes = [item.href, ...(item.match ?? [])];
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

type RoleKey = keyof Messages['roles'];

/** Translated role names, and the one line role summary shown in the sidebar and user menu. */
export function useRoleLabels() {
  const tr = useTranslations('roles');
  const ts = useTranslations('shell');
  const role = (r: string): string => (tr.has(r as RoleKey) ? tr(r as RoleKey) : r);
  const summary = (me: MeResponse): string => {
    if (me.user.platformRole) return role(me.user.platformRole);
    const roles = [...new Set(me.memberships.map((m) => role(m.role)))];
    return roles.length ? ts('customerRoles', { roles: roles.join(', ') }) : ts('noTenantAccess');
  };
  return { role, summary };
}

export function AppShell({ children }: { children: ReactNode }) {
  const t = useTranslations('shell');
  const tc = useTranslations('common');
  const roles = useRoleLabels();
  const me = useMe();
  const pathname = usePathname();
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (isApiError(me.error, 401)) router.replace(`/login?returnTo=${encodeURIComponent(pathname)}`);
  }, [me.error, pathname, router]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  if (me.isPending || isApiError(me.error, 401)) {
    return (
      <div className="min-h-dvh">
        <PageSpinner label={t('loading')} />
      </div>
    );
  }
  if (me.error || !me.data) {
    return (
      <main className="mx-auto max-w-lg px-4 py-16">
        <ErrorNotice
          title={t('sessionError')}
          error={me.error}
          action={
            <Button size="sm" onClick={() => me.refetch()}>
              {tc('retry')}
            </Button>
          }
        />
      </main>
    );
  }

  const nav = navFor(me.data);

  const sidebar = (
    <nav aria-label={t('nav.label')} className="flex h-full flex-col">
      <div className="flex h-12 items-center gap-2 border-b border-border px-4">
        <Link href="/" aria-label={t('home')} className="rounded">
          <Logo size="sm" />
        </Link>
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
        {nav.map((item) => {
          const active = isActive(pathname, item);
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm',
                  active
                    ? 'bg-accent/10 font-medium text-accent-ink before:absolute before:inset-y-1.5 before:-left-2 before:w-0.5 before:rounded-full before:bg-accent'
                    : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
                )}
              >
                <Icon size={15} aria-hidden />
                {t(`nav.${item.label}`)}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3 text-[11px] text-fg-subtle">
        <span>{roles.summary(me.data)}</span>
        <EditionBadge />
      </div>
    </nav>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[14rem_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[60] focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        {t('skipToContent')}
      </a>

      <aside className="sticky top-0 hidden h-dvh border-r border-border bg-surface lg:block">{sidebar}</aside>

      {navOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" aria-label={t('closeNav')} className="absolute inset-0 bg-black/50" onClick={() => setNavOpen(false)} />
          <aside id="mobile-nav" className="absolute inset-y-0 left-0 w-64 border-r border-border bg-surface shadow-2xl">
            <button
              type="button"
              onClick={() => setNavOpen(false)}
              className="absolute right-2 top-2.5 rounded p-1 text-fg-subtle hover:bg-surface-2"
              aria-label={t('closeNav')}
            >
              <X size={16} />
            </button>
            {sidebar}
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-surface/95 px-3 backdrop-blur sm:px-5">
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 lg:hidden"
            aria-label={t('openNav')}
            aria-expanded={navOpen}
            aria-controls="mobile-nav"
            onClick={() => setNavOpen(true)}
          >
            <Menu size={18} />
          </button>
          <Link href="/" className="rounded lg:hidden" aria-label={t('home')}>
            <Logo size="sm" variant="mark" />
          </Link>
          <TenantContext me={me.data} />
          <div className="ml-auto flex items-center gap-1">
            <NotificationsBell />
            <UserMenu me={me.data} />
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[90rem] flex-1 px-3 py-5 sm:px-6">
          {children}
        </main>
      </div>
    </div>
  );
}

function TenantContext({ me }: { me: MeResponse }) {
  const t = useTranslations('shell');
  if (me.user.platformRole) {
    return <span className="hidden truncate text-xs text-fg-subtle sm:inline">{t('platformContext')}</span>;
  }
  const names = me.memberships.map((m) => m.tenantName);
  return (
    <span className="hidden truncate text-xs text-fg-subtle sm:inline" title={names.join(', ')}>
      {names.length === 1 ? names[0] : t('tenantCount', { count: names.length })}
    </span>
  );
}

function UserMenu({ me }: { me: MeResponse }) {
  const t = useTranslations('shell.userMenu');
  const tc = useTranslations('common');
  const roles = useRoleLabels();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const qc = useQueryClient();
  const router = useRouter();
  const theme = useTheme();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  const logout = useMutation({
    mutationFn: () => apiSend('POST', '/auth/logout'),
    onSettled: () => {
      qc.clear();
      router.replace('/login');
    },
  });

  const initials = (me.user.name || me.user.email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('');

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={t('label', { email: me.user.email })}
        className="flex h-8 items-center gap-2 rounded-md px-1.5 text-sm text-fg-muted hover:bg-surface-2 hover:text-fg"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-2 text-[11px] font-semibold text-fg ring-1 ring-border">{initials}</span>
        <span className="hidden max-w-40 truncate md:inline">{me.user.name || me.user.email}</span>
      </button>
      {open ? (
        <div id={menuId} className="absolute right-0 z-50 mt-2 w-64 rounded-lg border border-border bg-surface p-1 shadow-2xl">
          <div className="px-3 py-2">
            <p className="truncate text-sm font-medium">{me.user.name}</p>
            <p className="truncate text-xs text-fg-subtle">{me.user.email}</p>
            <p className="mt-1 text-[11px] text-fg-subtle">{roles.summary(me)}</p>
          </div>
          {me.memberships.length > 0 ? (
            <ul className="border-t border-border px-3 py-2 text-xs text-fg-muted">
              {me.memberships.map((m) => (
                <li key={m.tenantId} className="flex justify-between gap-2 py-0.5">
                  <span className="truncate">{m.tenantName}</span>
                  <span className="text-fg-subtle">{roles.role(m.role)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="border-t border-border pt-1">
            <button
              type="button"
              role="switch"
              aria-checked={theme === 'light'}
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
              className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-fg-muted hover:bg-surface-2 hover:text-fg"
            >
              {theme === 'light' ? <Moon size={14} aria-hidden /> : <Sun size={14} aria-hidden />}
              <span className="flex-1">{t('lightTheme')}</span>
              <span className="text-[11px] text-fg-subtle">{theme === 'light' ? tc('on') : tc('off')}</span>
            </button>
          </div>
          <LanguageMenuGroup />
          <div className="border-t border-border pt-1">
            <button
              type="button"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
              className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-fg-muted hover:bg-surface-2 hover:text-fg"
            >
              <LogOut size={14} aria-hidden /> {t('signOut')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
