// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudCapability } from '@orkstage/cloud-core';

const SOURCE = 'Static CoreWeave list prices, US-EAST-04A, approximate (2026). Not an invoice.';

/**
 * CoreWeave implementations per logical resource kind. CoreWeave has no managed PostgreSQL,
 * Redis or queue service, so those kinds are left out on purpose: the resolver then asks for
 * them to be placed on another provider. Regions are CoreWeave zones (`*` = every zone the
 * target allows).
 */
export const COREWEAVE_CAPABILITIES: CloudCapability[] = [
  {
    provider: 'coreweave',
    serviceKind: 'network',
    capability: 'vpc',
    displayName: 'CoreWeave VPC',
    regions: '*',
    isDefault: true,
    features: ['nat-gateway'],
    supportsEncryption: true,
    supportsBackup: false,
    limitations: [
      'A VPC lives in one zone; multiple availability zones are not offered.',
      'Internet egress is built into the VPC; there is no separate NAT gateway.',
      'Container services run on the target\'s existing CKS cluster, which keeps its own VPC.',
    ],
    pricing: { currency: 'USD', baseMonthly: 0, source: SOURCE },
  },
  {
    provider: 'coreweave',
    serviceKind: 'compute.container-service',
    capability: 'cks-deployment',
    displayName: 'CoreWeave Kubernetes Service (Deployment)',
    regions: '*',
    isDefault: true,
    features: ['gpu', 'autoscaling', 'public-ingress'],
    supportsEncryption: true,
    supportsBackup: false,
    limitations: [
      'Runs on an existing CKS cluster (target clusterName or kubeconfig); node pools are managed outside OrkStage.',
      'GPUs are requested with providerOverrides.coreweave.gpu { count, class } and are not included in the estimate.',
      'The image must be pullable by the cluster (public, or a registry the cluster nodes can reach).',
    ],
    pricing: { currency: 'USD', baseMonthly: 0, perUnitMonthly: { vcpu: 21.9, memoryGiB: 3.65 }, source: SOURCE },
  },
  {
    provider: 'coreweave',
    serviceKind: 'object-storage',
    capability: 'ai-object-storage',
    displayName: 'CoreWeave AI Object Storage',
    regions: '*',
    isDefault: true,
    features: ['versioning', 'lifecycle', 'encryption'],
    supportsEncryption: true,
    supportsBackup: false,
    limitations: [
      'S3 compatible with virtual hosted style addressing only.',
      'Storage tiers follow access patterns automatically; the template tier is not applied.',
      'Buckets are private; public access is not configured.',
      'A bucket must be empty before it can be deleted.',
    ],
    pricing: { currency: 'USD', baseMonthly: 0, perUnitMonthly: { storageGiB: 0.06 }, source: SOURCE },
  },
  {
    provider: 'coreweave',
    serviceKind: 'ingress',
    capability: 'cks-ingress',
    displayName: 'CKS Ingress (Traefik and cert-manager)',
    regions: '*',
    isDefault: true,
    features: ['tls', 'path-routing'],
    supportsEncryption: true,
    supportsBackup: false,
    limitations: [
      'Needs an ingress controller in the cluster (CoreWeave Traefik chart by default) and cert-manager for TLS.',
      'The host name is under the cluster domain (<org>-<cluster>.coreweave.app) unless ingressDomain is set.',
    ],
    pricing: { currency: 'USD', baseMonthly: 0, source: SOURCE },
  },
];
