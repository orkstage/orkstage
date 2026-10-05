'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  CloudTargetDto,
  InstanceDto,
  Page,
  PlanDto,
  TemplateDto,
  TenantDto,
} from '@co/contracts';
import { apiGet, asItems, qs } from './api';

/** Shared list queries. Lists accept either a bare array or `Page<T>` from the API. */

export function useTenants(enabled = true) {
  return useQuery({
    queryKey: ['tenants'],
    queryFn: async ({ signal }) => asItems(await apiGet<TenantDto[] | Page<TenantDto>>('/tenants?limit=100', { signal })),
    enabled,
    staleTime: 30_000,
  });
}

export function usePlans(enabled = true) {
  return useQuery({
    queryKey: ['plans'],
    queryFn: async ({ signal }) => asItems(await apiGet<PlanDto[] | Page<PlanDto>>('/plans', { signal })),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useTemplates(enabled = true) {
  return useQuery({
    queryKey: ['templates'],
    queryFn: async ({ signal }) => asItems(await apiGet<TemplateDto[] | Page<TemplateDto>>('/templates', { signal })),
    enabled,
    staleTime: 30_000,
  });
}

export function useTemplate(id: string | null | undefined) {
  return useQuery({
    queryKey: ['template', id],
    queryFn: ({ signal }) => apiGet<TemplateDto>(`/templates/${id}`, { signal }),
    enabled: !!id,
  });
}

export function useCloudTargets(enabled = true) {
  return useQuery({
    queryKey: ['cloud-targets'],
    queryFn: async ({ signal }) => asItems(await apiGet<CloudTargetDto[] | Page<CloudTargetDto>>('/cloud/targets', { signal })),
    enabled,
    staleTime: 15_000,
  });
}

export function useInstances(filter: { tenantId?: string; status?: string } = {}) {
  return useQuery({
    queryKey: ['instances', filter],
    queryFn: async ({ signal }) =>
      asItems(await apiGet<InstanceDto[] | Page<InstanceDto>>(`/instances${qs({ limit: 100, ...filter })}`, { signal })),
    refetchInterval: 15_000,
  });
}

/** id → name lookup helper for tenant columns. */
export function tenantNameMap(tenants: TenantDto[] | undefined): Map<string, string> {
  return new Map((tenants ?? []).map((t) => [t.id, t.name]));
}
