'use client';

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { Badge } from './ui/badge';

interface License {
  edition: 'community' | 'enterprise';
  status: 'community' | 'active' | 'grace' | 'expired' | 'invalid';
  message: string;
}

/** Edition indicator in the sidebar. Visibility only — the API enforces Enterprise features. */
export function EditionBadge() {
  const license = useQuery({ queryKey: ['license'], queryFn: () => apiGet<License>('/license'), staleTime: 10 * 60_000 });
  if (!license.data) return null;
  const { edition, status, message } = license.data;
  if (edition === 'community') {
    return (
      <Badge title={status === 'invalid' ? message : 'OrkStage Community (AGPL-3.0)'} tone={status === 'invalid' ? 'warn' : 'neutral'}>
        Community
      </Badge>
    );
  }
  return (
    <Badge tone={status === 'active' ? 'accent' : 'warn'} title={message}>
      {status === 'active' ? 'Enterprise' : status === 'grace' ? 'Enterprise · renew' : 'Enterprise expired'}
    </Badge>
  );
}
