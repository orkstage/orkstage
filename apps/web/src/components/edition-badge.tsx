'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { apiGet } from '@/lib/api';
import { Badge } from './ui/badge';

interface License {
  edition: 'community' | 'enterprise';
  status: 'community' | 'active' | 'grace' | 'expired' | 'invalid';
  message: string;
}

/** Edition indicator in the sidebar. Visibility only: the API enforces Enterprise features. */
export function EditionBadge() {
  const t = useTranslations('edition');
  const license = useQuery({ queryKey: ['license'], queryFn: () => apiGet<License>('/license'), staleTime: 10 * 60_000 });
  if (!license.data) return null;
  const { edition, status, message } = license.data;
  if (edition === 'community') {
    return (
      <Badge title={status === 'invalid' ? message : t('communityTitle')} tone={status === 'invalid' ? 'warn' : 'neutral'}>
        {t('community')}
      </Badge>
    );
  }
  return (
    <Badge tone={status === 'active' ? 'accent' : 'warn'} title={message}>
      {status === 'active' ? t('enterprise') : status === 'grace' ? t('renew') : t('expired')}
    </Badge>
  );
}
