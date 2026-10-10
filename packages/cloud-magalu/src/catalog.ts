import type { CloudCapability } from '@orkstage/cloud-core';

const SOURCE = 'Static Magalu Cloud list prices, br-se1, approximate (2026). Not an invoice.';
const REGIONS = ['br-se1', 'br-ne1'];

/**
 * Magalu Cloud implementations per logical resource kind, provisioned with the MagaluCloud/mgc
 * OpenTofu provider. Prices are BRL list prices converted to USD and rounded.
 */
export const MAGALU_CAPABILITIES: CloudCapability[] = [
  {
    provider: 'magalu',
    serviceKind: 'network',
    capability: 'vpc',
    displayName: 'Magalu Cloud VPC',
    regions: REGIONS,
    isDefault: true,
    features: ['private-subnets', 'security-groups'],
    supportsEncryption: false,
    supportsBackup: false,
    limitations: [
      'One IPv4 subnet per network; availabilityZones does not create more subnets.',
      'natGateway is not applied: service VMs get a public IPv4 for outbound traffic, inbound is limited by security groups.',
    ],
    pricing: { currency: 'USD', baseMonthly: 0, source: SOURCE },
  },
  {
    provider: 'magalu',
    serviceKind: 'compute.container-service',
    capability: 'vm-docker',
    displayName: 'Magalu Cloud virtual machines running Docker',
    regions: REGIONS,
    isDefault: true,
    features: ['public-ingress', 'load-balancer', 'restart'],
    supportsEncryption: false,
    supportsBackup: false,
    limitations: [
      'One VM per replica; autoscaling is not available, replicas is fixed.',
      'The image must be pullable without registry credentials.',
      'Environment values are written to VM user data; dependency credentials arrive as <ID>_CREDENTIALS_REF references, not values.',
      'Public services with more than one replica get a network load balancer, which Magalu Cloud marks as experimental.',
      'Changing the image or environment replaces the VMs.',
    ],
    pricing: { currency: 'USD', baseMonthly: 0, perUnitMonthly: { vcpu: 6.5, memoryGiB: 1.8 }, source: SOURCE },
  },
  {
    provider: 'magalu',
    serviceKind: 'database.postgresql',
    capability: 'dbaas-postgres',
    displayName: 'Magalu Cloud DBaaS for PostgreSQL',
    regions: REGIONS,
    isDefault: true,
    features: ['ha:zone-redundant', 'backup', 'private-endpoint'],
    supportsEncryption: false,
    supportsBackup: true,
    limitations: [
      'Reachable on a private address only; publicAccess is not applied.',
      'Same zone HA is not offered; zone redundant HA uses a Multi AZ cluster.',
      'Automated backups are always on (1 to 35 days of retention).',
      'Only the PostgreSQL versions DBaaS lists as active in the region can be used.',
    ],
    pricing: {
      currency: 'USD',
      baseMonthly: 0,
      bySize: { micro: 25, small: 50, medium: 100, large: 280, xlarge: 560 },
      perUnitMonthly: { storageGiB: 0.12 },
      haMultiplier: 3,
      source: SOURCE,
    },
  },
  {
    provider: 'magalu',
    serviceKind: 'object-storage',
    capability: 'object-storage',
    displayName: 'Magalu Cloud Object Storage',
    regions: REGIONS,
    isDefault: true,
    features: ['versioning', 's3-compatible'],
    supportsEncryption: false,
    supportsBackup: false,
    limitations: [
      'Buckets are private; publicAccess, tier and retentionDays are not applied.',
      'A bucket must be empty before it can be destroyed.',
    ],
    pricing: { currency: 'USD', baseMonthly: 1, source: SOURCE },
  },
];
