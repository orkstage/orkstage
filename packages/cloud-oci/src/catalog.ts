// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudCapability } from '@orkstage/cloud-core';

const SOURCE = 'Static OCI list prices, us-ashburn-1, approximate (2026). Not an invoice.';

/**
 * OCI implementations for each logical resource kind. Regions are `*` (every region the target
 * allows); OCI services used here are available in all commercial regions.
 */
export const OCI_CAPABILITIES: CloudCapability[] = [
  {
    provider: 'oci',
    serviceKind: 'network',
    capability: 'vcn',
    displayName: 'OCI Virtual Cloud Network',
    regions: '*',
    isDefault: true,
    // Regional subnets span every availability domain, which covers `multi-az`.
    features: ['multi-az', 'regional-subnets', 'nat-gateway', 'service-gateway', 'private-subnets'],
    supportsEncryption: true,
    supportsBackup: false,
    limitations: [
      'Subnets are regional and span every availability domain, so availabilityZones does not change the layout.',
      'Regions with a single availability domain spread workloads across fault domains instead.',
    ],
    pricing: { currency: 'USD', baseMonthly: 0, source: SOURCE },
  },
  {
    provider: 'oci',
    serviceKind: 'compute.container-service',
    capability: 'container-instances',
    displayName: 'OCI Container Instances',
    regions: '*',
    isDefault: true,
    features: ['public-ingress', 'health-checks', 'restart'],
    supportsEncryption: true,
    supportsBackup: false,
    limitations: [
      'One container instance per replica; autoscaling is not available.',
      'CPU is allocated in whole OCPUs (1 OCPU = 2 vCPUs), so small services get at least 1 OCPU.',
      'Container instances have no secret environment variables: services receive the Vault secret OCID as <ID>_CREDENTIALS_REF and read it with their own identity.',
      'Images must be public or pulled from a registry the instance can reach without credentials.',
      'A new image or setting replaces the instances (new ones start before old ones stop).',
    ],
    pricing: { currency: 'USD', baseMonthly: 0, perUnitMonthly: { vcpu: 9.13, memoryGiB: 1.1 }, source: SOURCE },
  },
  {
    provider: 'oci',
    serviceKind: 'database.postgresql',
    capability: 'oci-postgresql',
    displayName: 'OCI Database with PostgreSQL',
    regions: '*',
    isDefault: true,
    features: ['ha:zone-redundant', 'ha:same-zone', 'backup', 'encryption', 'private-endpoint'],
    supportsEncryption: true,
    supportsBackup: true,
    limitations: [
      'Storage grows automatically and is billed by use; storageGiB is only used for estimates.',
      'Endpoints are private to the VCN; publicAccess is not supported.',
      'High availability adds a second node on regionally durable storage.',
      'Without vaultOcid and keyOcid on the target, each database creates its own vault, which OCI deletes only after a pending period.',
    ],
    pricing: {
      currency: 'USD',
      baseMonthly: 0,
      bySize: { micro: 100, small: 200, medium: 400, large: 800, xlarge: 1600 },
      perUnitMonthly: { storageGiB: 0.07 },
      haMultiplier: 2,
      source: SOURCE,
    },
  },
  {
    provider: 'oci',
    serviceKind: 'cache.redis',
    capability: 'oci-cache',
    displayName: 'OCI Cache (Valkey)',
    regions: '*',
    isDefault: true,
    features: ['replicas', 'encryption', 'private-endpoint', 'tls'],
    supportsEncryption: true,
    supportsBackup: false,
    limitations: ['Clients must connect with TLS.', 'At most four replicas.', 'No password: access is limited to the VCN.'],
    pricing: { currency: 'USD', baseMonthly: 0, bySize: { micro: 15, small: 30, medium: 59, large: 118 }, source: SOURCE },
  },
  {
    provider: 'oci',
    serviceKind: 'object-storage',
    capability: 'object-storage',
    displayName: 'OCI Object Storage',
    regions: '*',
    isDefault: true,
    features: ['versioning', 'lifecycle', 'encryption', 'auto-tiering', 's3-compatible'],
    supportsEncryption: true,
    supportsBackup: true,
    limitations: [
      'Buckets must be empty before they can be deleted.',
      'Expiry rules need a policy that lets the Object Storage service manage objects in the compartment.',
    ],
    pricing: { currency: 'USD', baseMonthly: 0, perUnitMonthly: { storageGiB: 0.0255 }, source: SOURCE },
  },
  {
    provider: 'oci',
    serviceKind: 'ingress',
    capability: 'flexible-load-balancer',
    displayName: 'OCI Flexible Load Balancer',
    regions: '*',
    isDefault: true,
    features: ['path-routing', 'health-checks'],
    supportsEncryption: true,
    supportsBackup: false,
    limitations: ['HTTP listener on port 80 only; TLS certificates are not managed yet.'],
    pricing: { currency: 'USD', baseMonthly: 9, source: SOURCE },
  },
];
