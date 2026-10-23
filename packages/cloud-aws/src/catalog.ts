// SPDX-License-Identifier: AGPL-3.0-only
import type { CapabilityPricing, CloudCapability } from '@orkstage/cloud-core';
import { AWS_PRICES_AS_OF, AWS_REGIONAL_PRICES } from './prices.generated.js';

/** Small nominal amounts for services billed by use (registry, queue, bucket, zone). */
const SOURCE = 'Static AWS list prices, us-east-1, on-demand, approximate (2026). Not an invoice.';
const TABLE_SOURCE = 'AWS list prices, on demand, approximate. Not an invoice.';

/**
 * Bundled prices of a capability (ADR 0010): the generated us-east-1 values as the default, and the
 * table of every generated region (prices.generated.ts, refreshed at release time).
 */
function priced(capability: string, base: Omit<CapabilityPricing, 'source'>): CapabilityPricing {
  const regions = AWS_REGIONAL_PRICES[capability] ?? {};
  const home = regions['us-east-1'];
  return {
    ...base,
    baseMonthly: home?.baseMonthly ?? base.baseMonthly,
    perUnitMonthly: { ...base.perUnitMonthly, ...home?.perUnitMonthly },
    bySize: home?.bySize ?? base.bySize,
    source: TABLE_SOURCE,
    asOf: AWS_PRICES_AS_OF,
    regions,
  };
}

/**
 * AWS implementations for each logical resource kind (spec §9). This mapping is data, not
 * domain logic: the resolver picks from it, and changing a default never touches the core.
 * Regions are `*` (every region the target allows); add `regionalGaps` as gaps are confirmed.
 */
export const AWS_CAPABILITIES: CloudCapability[] = [
  {
    provider: 'aws',
    serviceKind: 'network',
    capability: 'vpc',
    displayName: 'Amazon VPC',
    regions: '*',
    isDefault: true,
    features: ['multi-az', 'nat-gateway', 'private-subnets'],
    supportsEncryption: true,
    supportsBackup: false,
    pricing: priced('vpc', { currency: 'USD', baseMonthly: 0, perUnitMonthly: { availabilityZone: 32.85 } }),
  },
  {
    provider: 'aws',
    serviceKind: 'compute.container-service',
    capability: 'ecs-fargate',
    displayName: 'Amazon ECS on Fargate',
    regions: '*',
    isDefault: true,
    features: ['autoscaling', 'public-ingress', 'capacity:fargate-spot'],
    supportsEncryption: true,
    supportsBackup: false,
    pricing: priced('ecs-fargate', { currency: 'USD', baseMonthly: 0, perUnitMonthly: { vcpu: 29.55, memoryGiB: 3.24 } }),
  },
  {
    provider: 'aws',
    serviceKind: 'compute.container-service',
    capability: 'ecs-ec2',
    displayName: 'Amazon ECS on EC2 capacity',
    regions: '*',
    features: ['autoscaling', 'public-ingress', 'gpu', 'capacity:spot'],
    supportsEncryption: true,
    supportsBackup: false,
    limitations: ['Requires an EC2 capacity provider; instance sizing is bin-packed per cluster.'],
    pricing: priced('ecs-ec2', { currency: 'USD', baseMonthly: 0, perUnitMonthly: { vcpu: 22.0, memoryGiB: 2.75 } }),
  },
  {
    provider: 'aws',
    serviceKind: 'container-registry',
    capability: 'ecr',
    displayName: 'Amazon ECR (private)',
    regions: '*',
    isDefault: true,
    features: ['scan-on-push', 'immutable-tags', 'lifecycle'],
    supportsEncryption: true,
    supportsBackup: false,
    pricing: { currency: 'USD', baseMonthly: 1, source: SOURCE },
  },
  {
    provider: 'aws',
    serviceKind: 'database.postgresql',
    capability: 'rds-postgres',
    displayName: 'Amazon RDS for PostgreSQL',
    regions: '*',
    isDefault: true,
    features: ['ha:zone-redundant', 'backup', 'encryption', 'private-endpoint'],
    supportsEncryption: true,
    supportsBackup: true,
    limitations: ['Same-zone HA is not offered; Multi-AZ deployment is the HA option.'],
    pricing: priced('rds-postgres', {
      currency: 'USD',
      baseMonthly: 0,
      bySize: { micro: 11.68, small: 23.36, medium: 46.72, large: 186.88, xlarge: 373.76 },
      perUnitMonthly: { storageGiB: 0.115 },
      haMultiplier: 2,
    }),
  },
  {
    provider: 'aws',
    serviceKind: 'cache.redis',
    capability: 'elasticache-valkey',
    displayName: 'Amazon ElastiCache (Valkey/Redis OSS compatible)',
    regions: '*',
    isDefault: true,
    features: ['replicas', 'encryption', 'private-endpoint'],
    supportsEncryption: true,
    supportsBackup: true,
    pricing: priced('elasticache-valkey', {
      currency: 'USD',
      baseMonthly: 0,
      bySize: { micro: 9.34, small: 18.69, medium: 37.38, large: 149.5 },
    }),
  },
  {
    provider: 'aws',
    serviceKind: 'queue',
    capability: 'sqs',
    displayName: 'Amazon SQS',
    regions: '*',
    isDefault: true,
    features: ['fifo', 'dead-letter', 'encryption'],
    supportsEncryption: true,
    supportsBackup: false,
    pricing: { currency: 'USD', baseMonthly: 0.5, source: SOURCE },
  },
  {
    provider: 'aws',
    serviceKind: 'object-storage',
    capability: 's3',
    displayName: 'Amazon S3',
    regions: '*',
    isDefault: true,
    features: ['versioning', 'lifecycle', 'encryption', 'replication', 'block-public-access'],
    supportsEncryption: true,
    supportsBackup: true,
    pricing: { currency: 'USD', baseMonthly: 0.5, source: SOURCE },
  },
  {
    provider: 'aws',
    serviceKind: 'ingress',
    capability: 'alb',
    displayName: 'Application Load Balancer',
    regions: '*',
    isDefault: true,
    features: ['tls', 'path-routing', 'health-checks'],
    supportsEncryption: true,
    supportsBackup: false,
    pricing: priced('alb', { currency: 'USD', baseMonthly: 22.27 }),
  },
  {
    provider: 'aws',
    serviceKind: 'dns',
    capability: 'route53',
    displayName: 'Amazon Route 53 + ACM certificates',
    regions: '*',
    isDefault: true,
    features: ['subdomain', 'custom-domain', 'managed-tls'],
    supportsEncryption: true,
    supportsBackup: false,
    pricing: { currency: 'USD', baseMonthly: 0.5, source: SOURCE },
  },
];
