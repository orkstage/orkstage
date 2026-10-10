import { AWS_CAPABILITIES } from '@orkstage/cloud-aws/catalog';
import { AZURE_CAPABILITIES } from '@orkstage/cloud-azure/catalog';
import type { CloudCapability } from '@orkstage/cloud-core';
import { COREWEAVE_CAPABILITIES } from '@orkstage/cloud-coreweave/catalog';
import { DIGITALOCEAN_CAPABILITIES } from '@orkstage/cloud-digitalocean/catalog';
import { GCP_CAPABILITIES } from '@orkstage/cloud-gcp/catalog';
import { MAGALU_CAPABILITIES } from '@orkstage/cloud-magalu/catalog';
import { OCI_CAPABILITIES } from '@orkstage/cloud-oci/catalog';
import { RENDER_CAPABILITIES } from '@orkstage/cloud-render/catalog';
import { SUPABASE_CAPABILITIES } from '@orkstage/cloud-supabase/catalog';
import { VERCEL_CAPABILITIES } from '@orkstage/cloud-vercel/catalog';
import { VULTR_CAPABILITIES } from '@orkstage/cloud-vultr/catalog';

/**
 * The mock provider imitates a real provider's catalog (target config `simulate`), so multicloud
 * topologies can be planned, priced and "deployed" without any account. The catalogs are the real
 * adapters' own, so a simulated plan resolves to the same implementations a real one would.
 */
export const SIMULATED_CATALOGS = {
  aws: AWS_CAPABILITIES,
  azure: AZURE_CAPABILITIES,
  gcp: GCP_CAPABILITIES,
  oci: OCI_CAPABILITIES,
  digitalocean: DIGITALOCEAN_CAPABILITIES,
  vultr: VULTR_CAPABILITIES,
  coreweave: COREWEAVE_CAPABILITIES,
  magalu: MAGALU_CAPABILITIES,
  vercel: VERCEL_CAPABILITIES,
  render: RENDER_CAPABILITIES,
  supabase: SUPABASE_CAPABILITIES,
} satisfies Record<string, CloudCapability[]>;

export const SIMULATED_PROVIDERS = Object.keys(SIMULATED_CATALOGS) as SimulatedProvider[];
export type SimulatedProvider = keyof typeof SIMULATED_CATALOGS;
