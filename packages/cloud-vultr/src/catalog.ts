import type { CloudCapability } from '@orkstage/cloud-core';

const SOURCE = 'Static Vultr list prices, ewr, approximate (2026). Not an invoice.';

/** Regions with Vultr Load Balancers (the regions API lists `load_balancers` for them). */
export const LOAD_BALANCER_REGIONS = [
  'ams', 'atl', 'blr', 'bom', 'cdg', 'del', 'dfw', 'ewr', 'fra', 'hnl', 'icn', 'itm', 'jnb', 'lax', 'lhr', 'mad',
  'man', 'mel', 'mex', 'mia', 'nrt', 'ord', 'scl', 'sea', 'sgp', 'sjc', 'sto', 'syd', 'tlv', 'waw', 'yto',
];

/** Regions with Managed Database plans. */
export const MANAGED_DATABASE_REGIONS = [
  'ams', 'atl', 'blr', 'bom', 'cdg', 'dfw', 'ewr', 'fra', 'icn', 'itm', 'jnb', 'lax', 'lhr', 'mad', 'man', 'mel',
  'mex', 'mia', 'nrt', 'ord', 'scl', 'sea', 'sgp', 'sjc', 'sto', 'syd', 'tlv', 'waw', 'yto',
];

/** Regions with an Object Storage cluster open for new subscriptions. */
export const OBJECT_STORAGE_REGIONS = ['ams', 'atl', 'blr', 'del', 'ewr', 'lax', 'lhr', 'mxp', 'nrt', 'ord', 'sea', 'sgp', 'sjc', 'syd'];

/**
 * Vultr implementations for each logical resource kind. Vultr has no serverless containers, so
 * a container service runs as Docker on cloud compute instances. Regions are Vultr region ids.
 */
export const VULTR_CAPABILITIES: CloudCapability[] = [
  {
    provider: 'vultr',
    serviceKind: 'network',
    capability: 'vpc',
    displayName: 'Vultr VPC',
    regions: '*',
    isDefault: true,
    features: ['private-network'],
    supportsEncryption: false,
    supportsBackup: false,
    limitations: ['Vultr regions have no availability zones; availabilityZones is ignored.', 'No NAT gateway: instances keep a public address for egress, closed by a firewall group.'],
    pricing: { currency: 'USD', baseMonthly: 0, source: SOURCE },
  },
  {
    provider: 'vultr',
    serviceKind: 'compute.container-service',
    capability: 'instance-docker',
    displayName: 'Docker on Vultr Cloud Compute',
    regions: '*',
    isDefault: true,
    features: ['public-ingress', 'private-network', 'action:restart'],
    supportsEncryption: false,
    supportsBackup: false,
    limitations: [
      'One instance per replica; no autoscaling (the service runs max(replicas, autoscaling.minReplicas) instances).',
      'The image must be pullable without registry credentials.',
      'Injected database credentials are part of the instance user data, which account administrators can read.',
      'A new image or setting replaces the instances; the load balancer picks up the new ones after the apply.',
    ],
    pricing: { currency: 'USD', baseMonthly: 0, perUnitMonthly: { vcpu: 2.5, memoryGiB: 3.75 }, source: SOURCE },
  },
  {
    provider: 'vultr',
    serviceKind: 'database.postgresql',
    capability: 'managed-postgres',
    displayName: 'Vultr Managed Databases for PostgreSQL',
    regions: MANAGED_DATABASE_REGIONS,
    isDefault: true,
    features: ['ha:same-zone', 'backup', 'private-endpoint', 'public-endpoint'],
    supportsEncryption: true,
    supportsBackup: true,
    limitations: [
      'Storage is fixed by the plan; storageGiB is not applied.',
      'Backups are daily and managed by Vultr; retentionDays depends on the plan.',
      'No deletion protection on Vultr: production deletes rely on the platform approval.',
    ],
    pricing: {
      currency: 'USD',
      baseMonthly: 0,
      bySize: { micro: 15, small: 30, medium: 60, large: 120, xlarge: 240 },
      haMultiplier: 1.7,
      source: SOURCE,
    },
  },
  {
    provider: 'vultr',
    serviceKind: 'cache.redis',
    capability: 'managed-valkey',
    displayName: 'Vultr Managed Databases for Caching (Valkey)',
    regions: MANAGED_DATABASE_REGIONS,
    isDefault: true,
    features: ['replicas', 'encryption', 'private-endpoint', 'tls'],
    supportsEncryption: true,
    supportsBackup: true,
    limitations: ['Connections use TLS (rediss://).'],
    pricing: {
      currency: 'USD',
      baseMonthly: 0,
      bySize: { micro: 15, small: 30, medium: 60, large: 120 },
      haMultiplier: 1.7,
      source: SOURCE,
    },
  },
  {
    provider: 'vultr',
    serviceKind: 'object-storage',
    capability: 'object-storage',
    displayName: 'Vultr Object Storage',
    regions: OBJECT_STORAGE_REGIONS,
    isDefault: true,
    features: ['versioning', 's3-compatible'],
    supportsEncryption: true,
    supportsBackup: false,
    limitations: [
      'One subscription per resource (its own S3 keys), billed per subscription.',
      'Storage tiers are performance tiers, not storage classes: tier and retentionDays are not applied.',
      'Buckets are private; publicAccess is not applied.',
    ],
    pricing: { currency: 'USD', baseMonthly: 18, perUnitMonthly: { storageGiB: 0.018 }, source: SOURCE },
  },
  {
    provider: 'vultr',
    serviceKind: 'ingress',
    capability: 'load-balancer',
    displayName: 'Vultr Load Balancer',
    regions: LOAD_BALANCER_REGIONS,
    isDefault: true,
    features: ['health-checks', 'tls:auto-ssl-domain'],
    supportsEncryption: true,
    supportsBackup: false,
    limitations: [
      'No path routing, and one health check for all attached instances: one service per ingress.',
      'TLS needs a domain that already points at the load balancer (providerOverrides.vultr.autoSslDomain).',
    ],
    pricing: { currency: 'USD', baseMonthly: 10, source: SOURCE },
  },
];
