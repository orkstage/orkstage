'use client';

import { destroyInstanceSchema, upgradeInstanceSchema, type DeploymentSummaryDto, type InstanceDto } from '@co/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'use-intl';
import { useFormat } from '@/i18n/format';
import { useEnvironmentLabel } from '@/i18n/labels';
import { useZodResolver } from '@/i18n/zod';
import { apiSend } from '@/lib/api';
import { useTemplate } from '@/lib/queries';
import { newIdempotencyKey } from '@/lib/utils';
import { SimulatedBadge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { ErrorNotice, Notice } from '../ui/error-notice';
import { describedBy, Field, Input } from '../ui/input';
import { Select } from '../ui/select';
import { PageSpinner } from '../ui/spinner';

export function DeployDialog({ instance, open, onClose }: { instance: InstanceDto; open: boolean; onClose: () => void }) {
  const t = useTranslations('instanceDialogs');
  return (
    <Dialog open={open} onClose={onClose} title={t('deployTitle', { name: instance.name })} description={t('deployDescription')}>
      <DeployBody instance={instance} onClose={onClose} />
    </Dialog>
  );
}

function DeployBody({ instance, onClose }: { instance: InstanceDto; onClose: () => void }) {
  const t = useTranslations('instanceDialogs');
  const tc = useTranslations('common');
  const envLabel = useEnvironmentLabel();
  const router = useRouter();
  const qc = useQueryClient();
  // One key per dialog opening: a double click or retry after a network blip returns the same deployment.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const deploy = useMutation({
    mutationFn: () => apiSend<DeploymentSummaryDto>('POST', `/instances/${instance.id}/deploy`, {}, { headers: { 'idempotency-key': idempotencyKey } }),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ['instance', instance.id] });
      void qc.invalidateQueries({ queryKey: ['deployments'] });
      router.push(`/deployments/${d.id}`);
    },
  });
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-muted">{t('deployBody')}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
        <li>
          {t.rich('templateLine', { name: instance.template.displayName, strong: (chunks) => <strong className="text-fg">{chunks}</strong> })}{' '}
          <span className="font-mono text-xs">@{instance.template.version}</span>
        </li>
        <li>{t.rich('environmentLine', { environment: envLabel(instance.environment), strong: (chunks) => <strong className="text-fg">{chunks}</strong> })}</li>
      </ul>
      {instance.simulated ? (
        <Notice tone="info">
          <SimulatedBadge /> {t('simulatedNote')}
        </Notice>
      ) : null}
      {deploy.error ? <ErrorNotice error={deploy.error} /> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={onClose}>{tc('cancel')}</Button>
        <Button variant="primary" loading={deploy.isPending} onClick={() => deploy.mutate()}>
          {t('deploy')}
        </Button>
      </div>
    </div>
  );
}

export function DestroyDialog({ instance, open, onClose }: { instance: InstanceDto; open: boolean; onClose: () => void }) {
  const t = useTranslations('instanceDialogs');
  return (
    <Dialog open={open} onClose={onClose} title={t('destroyTitle', { name: instance.name })} description={t('destroyDescription')}>
      <DestroyBody instance={instance} onClose={onClose} />
    </Dialog>
  );
}

function DestroyBody({ instance, onClose }: { instance: InstanceDto; onClose: () => void }) {
  const t = useTranslations('instanceDialogs');
  const tc = useTranslations('common');
  const router = useRouter();
  const qc = useQueryClient();
  const mismatch = t('confirmMismatch');
  const schema = useMemo(
    () => destroyInstanceSchema.refine((v) => v.confirm === instance.slug, { message: mismatch, path: ['confirm'] }),
    [instance.slug, mismatch],
  );
  const form = useForm({ resolver: useZodResolver(schema), defaultValues: { confirm: '' }, mode: 'onChange' });
  const confirmValue = form.watch('confirm');
  const destroy = useMutation({
    mutationFn: (confirm: string) => apiSend<DeploymentSummaryDto>('POST', `/instances/${instance.id}/destroy`, { confirm }),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ['instance', instance.id] });
      void qc.invalidateQueries({ queryKey: ['instances'] });
      router.push(`/deployments/${d.id}`);
    },
  });
  const err = form.formState.errors.confirm?.message;

  if (instance.protectedFromDestroy) {
    return (
      <div className="space-y-3">
        <Notice tone="warn">{t('protected')}</Notice>
        <div className="flex justify-end">
          <Button onClick={onClose}>{tc('close')}</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={form.handleSubmit((v) => destroy.mutate(v.confirm))} className="space-y-4" noValidate>
      <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/8 p-3 text-sm">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger-ink" aria-hidden />
        <p>{t('destroyWarning', { count: instance.resources?.length ?? 0 })}</p>
      </div>
      <Field
        label={t.rich('confirmLabel', { slug: instance.slug, code: (chunks) => <code className="rounded bg-surface-2 px-1 font-mono text-fg">{chunks}</code> })}
        htmlFor="destroy-confirm"
        error={confirmValue && err ? err : undefined}
      >
        <Input id="destroy-confirm" autoComplete="off" spellCheck={false} className="font-mono" autoFocus {...describedBy('destroy-confirm', { error: confirmValue && err })} {...form.register('confirm')} />
      </Field>
      {destroy.error ? <ErrorNotice error={destroy.error} /> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={onClose}>{tc('cancel')}</Button>
        <Button type="submit" variant="danger" disabled={confirmValue !== instance.slug} loading={destroy.isPending}>
          {t('destroy')}
        </Button>
      </div>
    </form>
  );
}

export function UpgradeDialog({ instance, open, onClose, onUpgraded }: { instance: InstanceDto; open: boolean; onClose: () => void; onUpgraded: (version: string) => void }) {
  const t = useTranslations('instanceDialogs');
  return (
    <Dialog open={open} onClose={onClose} title={t('upgradeTitle')} description={t('upgradeDescription')}>
      <UpgradeBody instance={instance} onClose={onClose} onUpgraded={onUpgraded} />
    </Dialog>
  );
}

function UpgradeBody({ instance, onClose, onUpgraded }: { instance: InstanceDto; onClose: () => void; onUpgraded: (version: string) => void }) {
  const t = useTranslations('instanceDialogs');
  const tc = useTranslations('common');
  const fmt = useFormat();
  const qc = useQueryClient();
  const template = useTemplate(instance.template.id);
  const versions = (template.data?.versions ?? []).filter((v) => v.status === 'PUBLISHED' && v.id !== instance.template.versionId);
  const form = useForm({ resolver: useZodResolver(upgradeInstanceSchema), defaultValues: { templateVersionId: '' } });
  const upgrade = useMutation({
    mutationFn: (templateVersionId: string) => apiSend<InstanceDto>('POST', `/instances/${instance.id}/upgrade`, { templateVersionId }),
    onSuccess: (_res, templateVersionId) => {
      void qc.invalidateQueries({ queryKey: ['instance', instance.id] });
      onUpgraded(versions.find((v) => v.id === templateVersionId)?.version ?? '');
      onClose();
    },
  });

  if (template.isPending) return <PageSpinner />;
  if (template.error) return <ErrorNotice error={template.error} />;
  if (versions.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-fg-muted">
          {t.rich('noOtherVersion', {
            name: instance.template.displayName,
            version: instance.template.version,
            strong: (chunks) => <strong>{chunks}</strong>,
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
        <div className="flex justify-end">
          <Button onClick={onClose}>{tc('close')}</Button>
        </div>
      </div>
    );
  }
  const err = form.formState.errors.templateVersionId?.message;
  return (
    <form onSubmit={form.handleSubmit((v) => upgrade.mutate(v.templateVersionId))} className="space-y-4" noValidate>
      <p className="text-sm text-fg-muted">
        {t.rich('currentVersion', { version: instance.template.version, code: (chunks) => <code className="font-mono text-fg">{chunks}</code> })}
      </p>
      <Field label={t('targetVersion')} htmlFor="upgrade-version" error={err ? t('chooseVersion') : undefined}>
        <Select id="upgrade-version" {...describedBy('upgrade-version', { error: err })} {...form.register('templateVersionId')}>
          <option value="">{t('selectVersion')}</option>
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              {t('versionOption', { version: v.version, date: fmt.dateTime(v.publishedAt) })}
            </option>
          ))}
        </Select>
      </Field>
      {upgrade.error ? <ErrorNotice error={upgrade.error} /> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={onClose}>{tc('cancel')}</Button>
        <Button type="submit" variant="primary" loading={upgrade.isPending}>
          {t('changeVersion')}
        </Button>
      </div>
    </form>
  );
}
