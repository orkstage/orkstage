'use client';

import type { ApplicationDto, Page } from '@co/contracts';
import { useQuery } from '@tanstack/react-query';
import { AppWindow } from 'lucide-react';
import { Fragment } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { MonoValue } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorNotice } from '@/components/ui/error-notice';
import { PageHeader } from '@/components/ui/page-header';
import { PageSpinner } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { apiGet, asItems } from '@/lib/api';

export default function ApplicationsPage() {
  const q = useQuery({
    queryKey: ['applications'],
    queryFn: async ({ signal }) => asItems(await apiGet<ApplicationDto[] | Page<ApplicationDto>>('/applications', { signal })),
  });

  return (
    <>
      <PageHeader title="Applications" description="The container images your stages run. Templates reference them as catalog://<name>; every deploy pins an immutable digest." />
      <Card>
        {q.isPending ? (
          <PageSpinner />
        ) : q.error ? (
          <ErrorNotice error={q.error} className="m-4" />
        ) : q.data.length === 0 ? (
          <EmptyState icon={AppWindow} title="The catalog is empty" description="Applications appear here once images are registered for templates to use." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Application / version</TH>
                <TH>Registry</TH>
                <TH>Image</TH>
                <TH>Digest</TH>
                <TH>Architectures</TH>
                <TH>Scan</TH>
              </tr>
            </THead>
            <TBody>
              {q.data.map((app) => (
                <Fragment key={app.id}>
                  <tr className="bg-surface-2/60">
                    <TD colSpan={6} className="py-2">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-medium">{app.displayName}</span>
                        <code className="font-mono text-xs text-fg-subtle">catalog://{app.name}</code>
                        <span className="text-xs text-fg-muted">
                          port <span className="font-mono">{app.port}</span> · health <span className="font-mono">{app.healthPath}</span>
                        </span>
                        <MonoValue value={app.repository} maxWidth="max-w-[22rem]" />
                      </div>
                    </TD>
                  </tr>
                  {app.versions.length === 0 ? (
                    <TR>
                      <TD colSpan={6} className="pl-6 text-xs text-fg-subtle">
                        No versions.
                      </TD>
                    </TR>
                  ) : (
                    app.versions.map((v) => (
                      <TR key={`${app.id}-${v.version}`}>
                        <TD className="pl-6">
                          <code className="font-mono text-xs">{v.version}</code>
                        </TD>
                        <TD>
                          <Badge>{app.registryKind}</Badge>
                        </TD>
                        <TD>
                          <MonoValue value={v.imageUri} maxWidth="max-w-[16rem]" />
                        </TD>
                        <TD>
                          <MonoValue value={v.digest} maxWidth="max-w-[10rem]" />
                        </TD>
                        <TD>
                          <div className="flex flex-wrap gap-1">
                            {v.architectures.map((a) => (
                              <Badge key={a}>{a}</Badge>
                            ))}
                          </div>
                        </TD>
                        <TD>
                          <StatusBadge status={v.scanStatus} />
                        </TD>
                      </TR>
                    ))
                  )}
                </Fragment>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
