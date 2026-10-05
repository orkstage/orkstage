'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { abilityFromRules, subject, type Action, type AppAbility, type AppRule, type SubjectName } from '@co/authorization';
import type { MeResponse } from '@co/contracts';
import { apiGet } from './api';

/**
 * Feature visibility only. Hiding a button is never security: the API re-checks every action.
 */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: ({ signal }) => apiGet<MeResponse>('/me', { signal }),
    staleTime: 60_000,
    retry: false,
  });
}

export function useAbility(): AppAbility {
  const { data } = useMe();
  return useMemo(() => abilityFromRules((data?.rules ?? []) as AppRule[]), [data]);
}

/** `can('deploy', 'Instance', tenantId)` checks against a tenant-tagged subject when a tenant is given. */
export function useCan() {
  const ability = useAbility();
  return useMemo(
    () =>
      (action: Action, type: SubjectName, tenantId?: string | null): boolean =>
        tenantId === undefined ? ability.can(action, type) : ability.can(action, subject(type, { tenantId })),
    [ability],
  );
}

export function isPlatformStaff(me: MeResponse | undefined): boolean {
  return Boolean(me?.user.platformRole);
}

export { subject };
