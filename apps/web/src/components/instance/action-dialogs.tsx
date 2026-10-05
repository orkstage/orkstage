'use client';

import { destroyInstanceSchema, upgradeInstanceSchema, type DeploymentSummaryDto, type InstanceDto } from '@co/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { apiSend } from '@/lib/api';
import { useTemplate } from '@/lib/queries';
import { formatDateTime, newIdempotencyKey } from '@/lib/utils';
import { SimulatedBadge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { ErrorNotice, Notice } from '../ui/error-notice';
import { describedBy, Field, Input } from '../ui/input';
import { Select } from '../ui/select';
import { PageSpinner } from '../ui/spinner';

export function DeployDialog({ instance, open, onClose }: { instance: InstanceDto; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={`Deploy ${instance.name}`} description="Applies the current template version and variables to the bound cloud targets.">
      <DeployBody instance={instance} onClose={onClose} />
    </Dialog>
  );
}

function DeployBody({ instance, onClose }: { instance: InstanceDto; onClose: () => void }) {
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
      <p className="text-sm text-fg-muted">
        The deployment runs in the background; you will follow its progress live. Plans with high risk or protected environments may wait for approval.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
        <li>
          Template <strong className="text-fg">{instance.template.displayName}</strong> <span className="font-mono text-xs">@{instance.template.version}</span>
        </li>
        <li>
          Environment <strong className="text-fg">{instance.environment}</strong>
        </li>
      </ul>
      {instance.simulated ? (
        <Notice tone="info">
          <SimulatedBadge /> This instance uses mock targets: nothing is created in a real cloud.
        </Notice>
      ) : null}
      {deploy.error ? <ErrorNotice error={deploy.error} /> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={deploy.isPending} onClick={() => deploy.mutate()}>
          Deploy
        </Button>
      </div>
    </div>
  );
}

export function DestroyDialog({ instance, open, onClose }: { instance: InstanceDto; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={`Destroy ${instance.name}`} description="Deletes every cloud resource of this instance. This cannot be undone.">
      <DestroyBody instance={instance} onClose={onClose} />
    </Dialog>
  );
}

function DestroyBody({ instance, onClose }: { instance: InstanceDto; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const schema = useMemo(
    () => destroyInstanceSchema.refine((v) => v.confirm === instance.slug, { message: 'Type the instance slug exactly to confirm.', path: ['confirm'] }),
    [instance.slug],
  );
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { confirm: '' }, mode: 'onChange' });
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
        <Notice tone="warn">This instance is protected from destroy. Remove the protection in its settings first.</Notice>
        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={form.handleSubmit((v) => destroy.mutate(v.confirm))} className="space-y-4" noValidate>
      <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/8 p-3 text-sm">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger-ink" aria-hidden />
        <p>
          All resources ({instance.resources?.length ?? 0}) across every bound cloud target will be deleted, including databases and object storage. Backups follow each provider&apos;s retention policy.
        </p>
      </div>
      <Field
        label={
          <>
            Type <code className="rounded bg-surface-2 px-1 font-mono text-fg">{instance.slug}</code> to confirm
          </>
        }
        htmlFor="destroy-confirm"
        error={confirmValue && err ? err : undefined}
      >
        <Input id="destroy-confirm" autoComplete="off" spellCheck={false} className="font-mono" autoFocus {...describedBy('destroy-confirm', { error: confirmValue && err })} {...form.register('confirm')} />
      </Field>
      {destroy.error ? <ErrorNotice error={destroy.error} /> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="danger" disabled={confirmValue !== instance.slug} loading={destroy.isPending}>
          Destroy instance
        </Button>
      </div>
    </form>
  );
}

export function UpgradeDialog({ instance, open, onClose, onUpgraded }: { instance: InstanceDto; open: boolean; onClose: () => void; onUpgraded: (version: string) => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Change template version" description="Upgrading changes the definition only. Preview the plan, then deploy to apply it.">
      <UpgradeBody instance={instance} onClose={onClose} onUpgraded={onUpgraded} />
    </Dialog>
  );
}

function UpgradeBody({ instance, onClose, onUpgraded }: { instance: InstanceDto; onClose: () => void; onUpgraded: (version: string) => void }) {
  const qc = useQueryClient();
  const template = useTemplate(instance.template.id);
  const versions = (template.data?.versions ?? []).filter((v) => v.status === 'PUBLISHED' && v.id !== instance.template.versionId);
  const form = useForm({ resolver: zodResolver(upgradeInstanceSchema), defaultValues: { templateVersionId: '' } });
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
          No other published version of <strong>{instance.template.displayName}</strong> is available. Current version: <code className="font-mono">{instance.template.version}</code>.
        </p>
        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    );
  }
  const err = form.formState.errors.templateVersionId?.message;
  return (
    <form onSubmit={form.handleSubmit((v) => upgrade.mutate(v.templateVersionId))} className="space-y-4" noValidate>
      <p className="text-sm text-fg-muted">
        Current version: <code className="font-mono text-fg">{instance.template.version}</code>
      </p>
      <Field label="Target version" htmlFor="upgrade-version" error={err ? 'Choose a version.' : undefined}>
        <Select id="upgrade-version" {...describedBy('upgrade-version', { error: err })} {...form.register('templateVersionId')}>
          <option value="">Select a version…</option>
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.version} — published {formatDateTime(v.publishedAt)}
            </option>
          ))}
        </Select>
      </Field>
      {upgrade.error ? <ErrorNotice error={upgrade.error} /> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={upgrade.isPending}>
          Change version
        </Button>
      </div>
    </form>
  );
}
