import type { CloudCapability } from '@orkstage/cloud-core';

const SOURCE = 'Static Supabase list prices, all regions, approximate (2026). Not an invoice.';

/**
 * Supabase implementations. Each database is its own Supabase project; storage buckets live
 * inside a project created by a `supabase-postgres` resource. Prices are the compute addon list
 * prices; the organization plan fee (Pro includes a compute credit) is billed separately.
 */
export const SUPABASE_CAPABILITIES: CloudCapability[] = [
  {
    provider: 'supabase',
    serviceKind: 'database.postgresql',
    capability: 'supabase-postgres',
    displayName: 'Supabase Postgres project',
    regions: '*',
    isDefault: true,
    features: ['backup', 'encryption', 'connection-pooler', 'public-endpoint', 'rest-api', 'auth', 'storage'],
    supportsEncryption: true,
    supportsBackup: true,
    limitations: [
      'One Supabase project per database; the Postgres major version is chosen by Supabase.',
      'Free plan organizations get the Nano compute size whatever the template asks, at most two active projects, and projects pause after a week without activity.',
      'Compute size is applied at creation only; resizing later is done in the Supabase dashboard because it restarts the database.',
      'High availability is not offered through the Management API; read replicas are a separate paid addon.',
      'The direct host (db.<ref>.supabase.co) is IPv6 only without the IPv4 addon; IPv4 clients such as serverless functions should use the pooler.',
    ],
    pricing: {
      currency: 'USD',
      baseMonthly: 0,
      bySize: { micro: 10, small: 15, medium: 60, large: 110, xlarge: 210 },
      perUnitMonthly: { storageGiB: 0.125 },
      source: SOURCE,
    },
  },
  {
    provider: 'supabase',
    serviceKind: 'object-storage',
    capability: 'supabase-storage',
    displayName: 'Supabase Storage bucket',
    regions: '*',
    isDefault: true,
    features: ['s3-compatible', 'public-access', 'cdn'],
    supportsEncryption: true,
    supportsBackup: false,
    limitations: [
      'Needs a supabase-postgres resource in the template (dependsOn): the bucket lives in that project.',
      'No object versioning, lifecycle rules or storage tiers.',
      'S3 access keys are created in the Supabase dashboard; the platform shares the project service role key instead.',
      'Free plan: 1 GB of storage and 50 MB per file.',
    ],
    pricing: { currency: 'USD', baseMonthly: 0, perUnitMonthly: { storageGiB: 0.021 }, source: SOURCE },
  },
];
