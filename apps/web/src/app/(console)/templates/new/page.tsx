'use client';

import { createTemplateSchema, type TemplateDto, type ValidationIssueDto } from '@co/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { IssuesList } from '@/components/plan-view';
import { Workflow } from 'lucide-react';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { ErrorNotice } from '@/components/ui/error-notice';
import { PageHeader } from '@/components/ui/page-header';
import { Textarea } from '@/components/ui/textarea';
import { apiSend, isApiError } from '@/lib/api';

const STARTER = `apiVersion: platform/v1
kind: EnvironmentTemplate
metadata:
  name: my-template
  version: 1.0.0
  displayName: My template
  description: >
    What this environment is for.
  profile: starter
spec:
  plans: [STARTER, GROWTH]
  placements:
    - name: primary
      description: Everything runs in one account and region.
  variables:
    - { name: apiReplicas, type: number, default: 2, min: 1, max: 6, target: api.replicas }
  resources:
    - id: network
      type: network
      availabilityZones: 2
    - id: api
      type: compute.container-service
      image: catalog://sample-api
      replicas: 2
      cpu: 0.5
      memoryMiB: 1024
      port: 8080
      public: true
      healthCheckPath: /health
    - id: database
      type: database.postgresql
      size: small
      storageGiB: 20
    - id: ingress
      type: ingress
      routes:
        - service: api
  connectivity:
    - { from: api, to: database, protocol: postgres, port: 5432, mode: private-required }
`;

export default function NewTemplatePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const form = useForm({ resolver: zodResolver(createTemplateSchema), defaultValues: { source: STARTER } });
  const create = useMutation({
    mutationFn: (v: { source: string }) => apiSend<TemplateDto>('POST', '/templates', v),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: ['templates'] });
      router.push(`/templates/${t.id}`);
    },
  });
  const detailIssues = isApiError(create.error) && Array.isArray(create.error.details.issues) ? (create.error.details.issues as ValidationIssueDto[]) : [];
  const err = form.formState.errors.source?.message;

  return (
    <>
      <PageHeader
        title="New template"
        description="Forge a new blueprint. Paste YAML here, or start visually with the builder. It is saved as a draft; publish it when it validates."
        breadcrumb={
          <Link href="/templates" className="hover:underline">
            Templates
          </Link>
        }
        actions={
          <ButtonLink href="/templates/new/builder" variant="primary">
            <Workflow size={14} aria-hidden /> Start visually
          </ButtonLink>
        }
      />
      <Card>
        <form onSubmit={form.handleSubmit((v) => create.mutate(v))} noValidate>
          <CardBody className="space-y-3">
            <label htmlFor="new-tpl-source" className="block text-xs font-medium text-fg-muted">
              Template YAML
            </label>
            <Textarea
              id="new-tpl-source"
              spellCheck={false}
              className="min-h-[32rem] font-mono text-xs leading-relaxed"
              aria-invalid={err ? true : undefined}
              {...form.register('source')}
            />
            {err ? <p className="text-xs text-danger-ink">{err}</p> : null}
            {create.error ? <ErrorNotice error={create.error} title="The template was not created" /> : null}
            {detailIssues.length > 0 ? <IssuesList issues={detailIssues} /> : null}
          </CardBody>
          <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
            <Button onClick={() => router.push('/templates')}>Cancel</Button>
            <Button type="submit" variant="primary" loading={create.isPending}>
              Create draft
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}
