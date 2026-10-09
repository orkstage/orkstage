import { AWS_CAPABILITIES } from '@orkstage/cloud-aws/catalog';
import type { CloudCapability } from '@orkstage/cloud-core';

/**
 * SIMULATION CATALOGS. Azure and OCI adapters are not implemented yet (milestone 1 is AWS
 * first). These catalogs let the mock provider simulate multi-cloud topologies such as the
 * spec §42.17 scenario. Move each into its real provider package when that adapter lands.
 */
const SIM = 'Simulated catalog — approximate list prices for illustration only.';

const azure: CloudCapability[] = [
  { provider: 'azure', serviceKind: 'network', capability: 'vnet', displayName: 'Azure Virtual Network', regions: '*', isDefault: true, features: ['multi-az', 'private-subnets', 'nat-gateway'], supportsEncryption: true, supportsBackup: false, pricing: { currency: 'USD', baseMonthly: 0, perUnitMonthly: { availabilityZone: 32.85 }, source: SIM } },
  { provider: 'azure', serviceKind: 'compute.container-service', capability: 'container-apps', displayName: 'Azure Container Apps', regions: '*', isDefault: true, features: ['autoscaling', 'public-ingress'], supportsEncryption: true, supportsBackup: false, pricing: { currency: 'USD', baseMonthly: 0, perUnitMonthly: { vcpu: 63.07, memoryGiB: 7.88 }, source: SIM } },
  { provider: 'azure', serviceKind: 'container-registry', capability: 'acr', displayName: 'Azure Container Registry', regions: '*', isDefault: true, features: ['scan-on-push', 'immutable-tags'], supportsEncryption: true, supportsBackup: false, pricing: { currency: 'USD', baseMonthly: 5, source: SIM } },
  {
    provider: 'azure',
    serviceKind: 'database.postgresql',
    capability: 'flexible-server',
    displayName: 'Azure Database for PostgreSQL Flexible Server',
    regions: '*',
    isDefault: true,
    features: ['ha:same-zone', 'ha:zone-redundant', 'backup', 'encryption', 'private-endpoint'],
    supportsEncryption: true,
    supportsBackup: true,
    limitations: ['Zone-redundant HA depends on region and compute tier; Burstable tiers do not support HA.'],
    pricing: { currency: 'USD', baseMonthly: 0, bySize: { micro: 12.41, small: 24.82, medium: 125.56, large: 251.12, xlarge: 502.24 }, perUnitMonthly: { storageGiB: 0.115 }, haMultiplier: 2, source: SIM },
  },
  { provider: 'azure', serviceKind: 'cache.redis', capability: 'azure-cache-redis', displayName: 'Azure Cache for Redis', regions: '*', isDefault: true, features: ['replicas', 'encryption'], supportsEncryption: true, supportsBackup: false, pricing: { currency: 'USD', baseMonthly: 0, bySize: { micro: 16.06, small: 40.15, medium: 100.74, large: 201.48 }, source: SIM } },
  { provider: 'azure', serviceKind: 'queue', capability: 'service-bus', displayName: 'Azure Service Bus', regions: '*', isDefault: true, features: ['fifo', 'dead-letter', 'encryption'], supportsEncryption: true, supportsBackup: false, pricing: { currency: 'USD', baseMonthly: 9.81, source: SIM } },
  { provider: 'azure', serviceKind: 'object-storage', capability: 'blob-storage', displayName: 'Azure Blob Storage', regions: '*', isDefault: true, features: ['versioning', 'lifecycle', 'encryption', 'block-public-access'], supportsEncryption: true, supportsBackup: true, pricing: { currency: 'USD', baseMonthly: 0.5, source: SIM } },
  { provider: 'azure', serviceKind: 'ingress', capability: 'application-gateway', displayName: 'Azure Application Gateway', regions: '*', isDefault: true, features: ['tls', 'path-routing', 'health-checks'], supportsEncryption: true, supportsBackup: false, pricing: { currency: 'USD', baseMonthly: 179.58, source: SIM } },
  { provider: 'azure', serviceKind: 'dns', capability: 'azure-dns', displayName: 'Azure DNS', regions: '*', isDefault: true, features: ['subdomain', 'custom-domain'], supportsEncryption: true, supportsBackup: false, pricing: { currency: 'USD', baseMonthly: 0.5, source: SIM } },
];

const oci: CloudCapability[] = [
  { provider: 'oci', serviceKind: 'network', capability: 'vcn', displayName: 'OCI Virtual Cloud Network', regions: '*', isDefault: true, features: ['private-subnets', 'nat-gateway'], supportsEncryption: true, supportsBackup: false, pricing: { currency: 'USD', baseMonthly: 0, source: SIM } },
  { provider: 'oci', serviceKind: 'compute.container-service', capability: 'container-instances', displayName: 'OCI Container Instances', regions: '*', isDefault: true, features: ['public-ingress'], supportsEncryption: true, supportsBackup: false, pricing: { currency: 'USD', baseMonthly: 0, perUnitMonthly: { vcpu: 18.25, memoryGiB: 1.1 }, source: SIM } },
  { provider: 'oci', serviceKind: 'database.postgresql', capability: 'oci-postgresql', displayName: 'OCI Database with PostgreSQL', regions: '*', isDefault: true, features: ['ha:zone-redundant', 'backup', 'encryption', 'private-endpoint'], supportsEncryption: true, supportsBackup: true, pricing: { currency: 'USD', baseMonthly: 0, bySize: { micro: 30, small: 60, medium: 120, large: 240, xlarge: 480 }, perUnitMonthly: { storageGiB: 0.0255 }, haMultiplier: 2, source: SIM } },
  { provider: 'oci', serviceKind: 'object-storage', capability: 'object-storage', displayName: 'OCI Object Storage', regions: '*', isDefault: true, features: ['versioning', 'lifecycle', 'encryption', 'replication', 'block-public-access'], supportsEncryption: true, supportsBackup: true, pricing: { currency: 'USD', baseMonthly: 0.26, source: SIM } },
];

export const SIMULATED_CATALOGS = {
  aws: AWS_CAPABILITIES,
  azure,
  oci,
} as const;

export type SimulatedProvider = keyof typeof SIMULATED_CATALOGS;
