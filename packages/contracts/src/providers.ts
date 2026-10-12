// SPDX-License-Identifier: AGPL-3.0-only
import type { PROVIDERS } from './requests.js';

type Provider = (typeof PROVIDERS)[number];

export interface ProviderConfigField {
  /** Key in the target's non secret `config`. */
  key: string;
  required: boolean;
  example: string;
  /** Regular expression the value must match, when the format is fixed. */
  pattern?: string;
  /** Value used when the field is left empty. */
  defaultValue?: string;
}

export interface ProviderForm {
  config: ProviderConfigField[];
  /**
   * Fields of the JSON secret behind `credentialRef`. A single entry means the secret may also be
   * the plain value (an API token). Empty for providers that need no credential.
   */
  credentialFields: string[];
  regionsExample: string;
}

const UUID = '^[0-9a-fA-F-]{36}$';
const OCID = '^ocid1\\.[a-z0-9]+\\.[a-z0-9-]*\\.[a-z0-9-]*\\.[a-z0-9]+$';

/**
 * What registering a target asks for, per provider: the console renders these fields, the CLI
 * prints them, and each adapter checks the same values again when it validates the target.
 */
export const PROVIDER_FORMS: Record<Provider, ProviderForm> = {
  aws: {
    config: [
      { key: 'accountId', required: true, example: '123456789012', pattern: '^\\d{12}$' },
      { key: 'roleArn', required: true, example: 'arn:aws:iam::123456789012:role/orkstage-deploy', pattern: '^arn:aws[a-z-]*:iam::\\d{12}:role\\/.+$' },
      { key: 'stateBucket', required: false, example: 'orkstage-tfstate-123456789012-us-east-1' },
    ],
    credentialFields: ['externalId'],
    regionsExample: 'us-east-1, sa-east-1',
  },
  azure: {
    config: [
      { key: 'tenantId', required: true, example: '00000000-0000-0000-0000-000000000000', pattern: UUID },
      { key: 'subscriptionId', required: true, example: '00000000-0000-0000-0000-000000000000', pattern: UUID },
      { key: 'clientId', required: true, example: '00000000-0000-0000-0000-000000000000', pattern: UUID },
      { key: 'stateResourceGroup', required: true, example: 'orkstage-state' },
      { key: 'stateStorageAccount', required: true, example: 'orkstagestate1234', pattern: '^[a-z0-9]{3,24}$' },
      { key: 'stateContainer', required: false, example: 'orkstage-tfstate', defaultValue: 'orkstage-tfstate' },
    ],
    credentialFields: ['clientSecret'],
    regionsExample: 'eastus, brazilsouth',
  },
  gcp: {
    config: [
      { key: 'projectId', required: true, example: 'acme-prod', pattern: '^[a-z][a-z0-9-]{4,28}[a-z0-9]$' },
      { key: 'stateBucket', required: true, example: 'acme-prod-orkstage-tfstate' },
    ],
    credentialFields: ['client_email', 'private_key', 'project_id'],
    regionsExample: 'us-central1, southamerica-east1',
  },
  oci: {
    config: [
      { key: 'tenancyOcid', required: true, example: 'ocid1.tenancy.oc1..aaaa', pattern: OCID },
      { key: 'userOcid', required: true, example: 'ocid1.user.oc1..aaaa', pattern: OCID },
      { key: 'fingerprint', required: true, example: '12:34:56:78:9a:bc:de:f0:12:34:56:78:9a:bc:de:f0', pattern: '^([0-9a-f]{2}:){15}[0-9a-f]{2}$' },
      { key: 'compartmentOcid', required: true, example: 'ocid1.compartment.oc1..aaaa', pattern: OCID },
      { key: 'namespace', required: true, example: 'axabcdefghij' },
      { key: 'stateBucket', required: true, example: 'orkstage-tfstate' },
      { key: 'vaultOcid', required: false, example: 'ocid1.vault.oc1..aaaa' },
      { key: 'keyOcid', required: false, example: 'ocid1.key.oc1..aaaa' },
    ],
    credentialFields: ['privateKey', 'stateAccessKeyId', 'stateSecretAccessKey'],
    regionsExample: 'us-ashburn-1, sa-saopaulo-1',
  },
  digitalocean: {
    config: [
      { key: 'stateBucket', required: true, example: 'acme-orkstage-tfstate' },
      { key: 'stateRegion', required: true, example: 'nyc3' },
    ],
    credentialFields: ['token', 'spacesAccessKeyId', 'spacesSecretAccessKey'],
    regionsExample: 'nyc3, sfo3',
  },
  vultr: {
    config: [
      { key: 'stateBucket', required: true, example: 'acme-orkstage-tfstate' },
      { key: 'stateEndpoint', required: true, example: 'ewr1.vultrobjects.com' },
    ],
    credentialFields: ['apiKey', 'stateAccessKeyId', 'stateSecretAccessKey'],
    regionsExample: 'ewr, sao',
  },
  coreweave: {
    config: [
      { key: 'clusterName', required: false, example: 'acme-gpu' },
      { key: 'zone', required: false, example: 'US-EAST-04A' },
      { key: 'stateBucket', required: true, example: 'acme-orkstage-tfstate' },
      { key: 'stateEndpoint', required: false, example: 'https://cwobject.com', defaultValue: 'https://cwobject.com' },
      { key: 'ingressDomain', required: false, example: 'acme-gpu.coreweave.app' },
      { key: 'ingressClassName', required: false, example: 'traefik' },
      { key: 'clusterIssuer', required: false, example: 'letsencrypt-prod' },
    ],
    credentialFields: ['token', 'stateAccessKeyId', 'stateSecretAccessKey', 'kubeconfig'],
    regionsExample: 'US-EAST-04A',
  },
  magalu: {
    config: [
      { key: 'stateBucket', required: true, example: 'acme-orkstage-tfstate' },
      { key: 'sshKeyName', required: false, example: 'acme-ops' },
    ],
    credentialFields: ['apiKey', 'stateAccessKeyId', 'stateSecretAccessKey'],
    regionsExample: 'br-se1, br-ne1',
  },
  vercel: {
    config: [{ key: 'teamId', required: false, example: 'team_abc123' }],
    credentialFields: ['token'],
    regionsExample: 'iad1, gru1',
  },
  render: {
    config: [
      { key: 'ownerId', required: true, example: 'tea-abc123', pattern: '^(tea|usr)-[a-z0-9]+$' },
      { key: 'registryCredentialId', required: false, example: 'rgc-abc123' },
    ],
    credentialFields: ['apiKey'],
    regionsExample: 'oregon, virginia',
  },
  supabase: {
    config: [{ key: 'organizationId', required: true, example: 'acme-org' }],
    credentialFields: ['token'],
    regionsExample: 'us-east-1, sa-east-1',
  },
  mock: { config: [], credentialFields: [], regionsExample: 'us-east-1, eu-west-1' },
};
