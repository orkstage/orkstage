// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudCapability } from '@orkstage/cloud-core';

const SOURCE = 'Static Render list prices, all regions, approximate (2026). Not an invoice.';

/** Regions the Render API accepts for services and datastores. */
const REGIONS = ['oregon', 'ohio', 'virginia', 'frankfurt', 'singapore'];

/**
 * Render implementations for each logical resource kind. Render bills compute by plan, not by
 * vCPU; the per unit prices below approximate the plan that fits the requested size.
 */
export const RENDER_CAPABILITIES: CloudCapability[] = [
  {
    provider: 'render',
    serviceKind: 'web.frontend',
    capability: 'render-static-site',
    displayName: 'Render Static Site',
    // Static sites are served from a global CDN, so the target region does not apply.
    regions: '*',
    isDefault: true,
    features: ['cdn', 'custom-domain', 'preview-deployments', 'git-deploy'],
    supportsEncryption: true,
    supportsBackup: false,
    limitations: [
      'Builds from a repository connected to Render through its GitHub, GitLab or Bitbucket app.',
      'Environment variables are only available at build time.',
      'Bandwidth beyond the workspace allowance is billed separately.',
    ],
    pricing: { currency: 'USD', baseMonthly: 0, source: SOURCE },
  },
  {
    provider: 'render',
    serviceKind: 'compute.container-service',
    capability: 'render-web-service',
    displayName: 'Render Web Service (image)',
    regions: REGIONS,
    isDefault: true,
    features: ['autoscaling', 'public-ingress', 'private-network', 'zero-downtime-deploy'],
    supportsEncryption: true,
    supportsBackup: false,
    limitations: [
      'Deploys a prebuilt image; services that are not public become Render private services.',
      'Autoscaling needs a Professional workspace or higher.',
      'Billed per plan, such as 0.5c-512mb or 1c-2g; the smallest plan that fits cpu and memoryMiB is used.',
    ],
    pricing: { currency: 'USD', baseMonthly: 0, perUnitMonthly: { vcpu: 30, memoryGiB: 6 }, source: SOURCE },
  },
  {
    provider: 'render',
    serviceKind: 'compute.container-service',
    capability: 'render-private-service',
    displayName: 'Render Private Service (image)',
    regions: REGIONS,
    features: ['autoscaling', 'private-network'],
    supportsEncryption: true,
    supportsBackup: false,
    limitations: ['Reachable only from Render services in the same workspace and region.', 'Autoscaling needs a Professional workspace or higher.'],
    pricing: { currency: 'USD', baseMonthly: 0, perUnitMonthly: { vcpu: 30, memoryGiB: 6 }, source: SOURCE },
  },
  {
    provider: 'render',
    serviceKind: 'database.postgresql',
    capability: 'render-postgres',
    displayName: 'Render Postgres',
    regions: REGIONS,
    isDefault: true,
    features: ['ha:zone-redundant', 'backup', 'encryption', 'private-endpoint'],
    supportsEncryption: true,
    supportsBackup: true,
    limitations: [
      'High availability needs a plan with at least 1 CPU (size medium or larger) and PostgreSQL 13 or later.',
      'Storage grows in 5 GB steps and cannot shrink.',
      'The major version cannot be changed in place.',
    ],
    pricing: {
      currency: 'USD',
      baseMonthly: 0,
      bySize: { micro: 6, small: 19, medium: 55, large: 100, xlarge: 200 },
      perUnitMonthly: { storageGiB: 0.3 },
      haMultiplier: 2,
      source: SOURCE,
    },
  },
  {
    provider: 'render',
    serviceKind: 'cache.redis',
    capability: 'render-key-value',
    displayName: 'Render Key Value (Valkey compatible)',
    regions: REGIONS,
    isDefault: true,
    features: ['encryption', 'private-endpoint', 'persistence'],
    supportsEncryption: true,
    supportsBackup: false,
    limitations: ['Single node: read replicas are not offered.', 'External access is closed; services reach it over the private network.'],
    pricing: {
      currency: 'USD',
      baseMonthly: 0,
      bySize: { micro: 10, small: 20, medium: 100, large: 200 },
      source: SOURCE,
    },
  },
];
