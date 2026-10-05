'use client';

import type { DeploymentSummaryDto, Page } from '@co/contracts';
import { useQuery } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { useCloudTargets, useTemplates } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Card } from './ui/card';

const DISMISS_KEY = 'orkstage-onboarding-dismissed';

/**
 * First-run checklist for platform staff. Shown while the fleet is empty or no cloud target has
 * passed validation; every step derives "done" from data the console already loads.
 */
export function OnboardingChecklist({ instanceCount }: { instanceCount: number }) {
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      setDismissed(false);
    }
  }, []);

  const targets = useCloudTargets();
  const templates = useTemplates();
  const deployments = useQuery({
    queryKey: ['onboarding-deployments'],
    queryFn: ({ signal }) => apiGet<Page<DeploymentSummaryDto>>('/deployments?limit=10', { signal }),
    staleTime: 30_000,
  });

  const validatedTarget = (targets.data ?? []).some((t) => t.lastValidation?.ok);
  const show = !dismissed && targets.isSuccess && (instanceCount === 0 || !validatedTarget);
  if (!show) return null;

  const deps = deployments.data?.items ?? [];
  const steps = [
    { label: 'Connect or validate a cloud target', hint: 'Give OrkStage an account to build on, or a mock target to rehearse.', href: '/cloud-targets', done: validatedTarget },
    { label: 'Pick or forge a template', hint: 'Start from a system blueprint or build your own visually.', href: '/templates', done: (templates.data ?? []).some((t) => t.latestPublished) },
    { label: 'Create an instance', hint: 'Choose the customer, template and where each part runs.', href: '/instances/new', done: instanceCount > 0 },
    { label: 'Review plan & cost', hint: 'See every change and the approximate monthly cost before anything runs.', href: '/instances', done: deps.length > 0 },
    { label: 'Deploy and watch', hint: 'Follow the rollout live, then keep watch from the status page.', href: '/deployments', done: deps.some((d) => d.kind === 'APPLY' && d.status === 'SUCCEEDED') },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <Card className="bg-grid mb-4 overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="font-display text-base font-semibold">Set the stage</h2>
          <p className="text-xs text-fg-subtle">
            Five steps from an empty console to a watched, running environment. {doneCount} of {steps.length} done.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setDismissed(true);
            try {
              localStorage.setItem(DISMISS_KEY, '1');
            } catch {
              /* ignore */
            }
          }}
          className="rounded p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
          aria-label="Dismiss the getting started checklist"
        >
          <X size={16} />
        </button>
      </div>
      <ol className="grid gap-px bg-border sm:grid-cols-5">
        {steps.map((s, i) => (
          <li key={s.label} className="bg-surface">
            <Link href={s.href} className="flex h-full gap-3 px-4 py-3 hover:bg-surface-2">
              <span
                className={cn(
                  'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                  s.done ? 'bg-accent text-accent-fg' : 'border border-control text-fg-muted',
                )}
                aria-hidden
              >
                {s.done ? <Check size={12} strokeWidth={3} /> : i + 1}
              </span>
              <span>
                <span className="block text-sm font-medium text-fg">
                  {s.label}
                  <span className="sr-only">{s.done ? ' (done)' : ' (not done)'}</span>
                </span>
                <span className="block text-xs text-fg-subtle">{s.hint}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}
