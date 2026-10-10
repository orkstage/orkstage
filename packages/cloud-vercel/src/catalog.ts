import type { CloudCapability } from '@orkstage/cloud-core';
import { VERCEL_REGIONS } from './config.js';

const SOURCE = 'Static Vercel list prices, all regions, approximate (2026). Not an invoice.';

/**
 * Vercel implementations. A web frontend is one Vercel project connected to a Git repository.
 * Vercel bills per team seat and usage, not per project, so the static estimate is zero.
 */
export const VERCEL_CAPABILITIES: CloudCapability[] = [
  {
    provider: 'vercel',
    serviceKind: 'web.frontend',
    capability: 'vercel-project',
    displayName: 'Vercel project',
    regions: [...VERCEL_REGIONS],
    isDefault: true,
    features: ['preview-deployments', 'custom-domain', 'edge-network'],
    supportsEncryption: true,
    supportsBackup: false,
    limitations: [
      'Vercel charges per team seat (Pro is about 20 USD per member per month) plus usage above the plan allowance; nothing is charged per project, so the estimate shows 0.',
      'The region sets where Vercel Functions run; static assets are always served from the global edge network.',
      'The repository must be readable by the Vercel Git app (GitHub, GitLab or Bitbucket) on the account or team that owns the token.',
      'The production branch follows the repository default branch; change it in the project settings when the template uses another branch.',
      'Custom domains are attached to the project but their DNS records are managed outside the platform.',
    ],
    pricing: { currency: 'USD', baseMonthly: 0, source: SOURCE },
  },
];
