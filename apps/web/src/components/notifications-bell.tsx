'use client';

import type { NotificationDto, Page } from '@co/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useId, useRef, useState } from 'react';
import { apiGet, apiSend, asItems } from '@/lib/api';
import { useDismiss } from '@/lib/hooks';
import { cn, formatRelative } from '@/lib/utils';
import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';
import { ErrorNotice } from './ui/error-notice';

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const router = useRouter();
  const qc = useQueryClient();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  const query = useQuery({
    queryKey: ['notifications'],
    queryFn: async ({ signal }) => asItems(await apiGet<NotificationDto[] | Page<NotificationDto>>('/notifications', { signal })),
    refetchInterval: 30_000,
  });

  const markRead = useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map((id) => apiSend('POST', `/notifications/${id}/read`))),
    onMutate: (ids) => {
      // Optimistic: the bell count drops immediately.
      const now = new Date().toISOString();
      qc.setQueryData<NotificationDto[]>(['notifications'], (prev) => prev?.map((n) => (ids.includes(n.id) && !n.readAt ? { ...n, readAt: now } : n)));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const items = query.data ?? [];
  const unread = items.filter((n) => !n.readAt);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Notifications${unread.length ? `, ${unread.length} unread` : ''}`}
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg"
      >
        <Bell size={16} aria-hidden />
        {unread.length > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-danger-fg">
            {unread.length > 99 ? '99+' : unread.length}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          id={panelId}
          role="region"
          aria-label="Notifications"
          className="absolute right-0 z-50 mt-2 w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <p className="text-sm font-semibold">Notifications</p>
            <Button size="sm" variant="ghost" disabled={unread.length === 0 || markRead.isPending} onClick={() => markRead.mutate(unread.map((n) => n.id))}>
              Mark all read
            </Button>
          </div>
          <div className="max-h-[26rem] overflow-y-auto">
            {query.error ? <ErrorNotice error={query.error} className="m-3" /> : null}
            {items.length === 0 && !query.error ? (
              <EmptyState icon={Bell} title="You're all caught up" description="Deployment, incident and health alerts from across your fleet appear here." />
            ) : (
              <ul className="divide-y divide-border">
                {items.map((n) => (
                  <li key={n.id} className={cn('flex gap-2.5 px-3 py-2.5', !n.readAt && 'bg-accent/5')}>
                    <span aria-hidden className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-accent')} />
                    <div className="min-w-0 flex-1">
                      {n.link ? (
                        <button
                          type="button"
                          className="text-left text-sm font-medium text-fg hover:underline"
                          onClick={() => {
                            if (!n.readAt) markRead.mutate([n.id]);
                            setOpen(false);
                            // Only in-app paths are followed; anything else is ignored.
                            if (n.link?.startsWith('/') && !n.link.startsWith('//')) router.push(n.link);
                          }}
                        >
                          {n.title}
                        </button>
                      ) : (
                        <p className="text-sm font-medium text-fg">{n.title}</p>
                      )}
                      {n.body ? <p className="line-clamp-2 text-xs text-fg-muted">{n.body}</p> : null}
                      <p className="mt-0.5 text-[11px] text-fg-subtle">
                        <time dateTime={n.createdAt}>{formatRelative(n.createdAt)}</time> · {n.event}
                      </p>
                    </div>
                    {!n.readAt ? (
                      <Button size="sm" variant="ghost" className="self-start" onClick={() => markRead.mutate([n.id])} aria-label={`Mark "${n.title}" as read`}>
                        Mark read
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
