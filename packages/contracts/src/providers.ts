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
  /**
   * Cannot change once the target exists: it names the account, or where the OpenTofu state of
   * existing resources lives. A different value means a new target.
   */
  fixed?: boolean;
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
      { key: 'accountId', required: true, example: '123456789012', pattern: '^\\d{12}$', fixed: true },
      { key: 'roleArn', required: true, example: 'arn:aws:iam::123456789012:role/orkstage-deploy', pattern: '^arn:aws[a-z-]*:iam::\\d{12}:role\\/.+$' },
      { key: 'stateBucket', required: false, example: 'orkstage-tfstate-123456789012-us-east-1', fixed: true },
      { key: 'dnsZone', required: false, example: 'apps.example.com', pattern: '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$' },
    ],
    credentialFields: ['externalId'],
    regionsExample: 'us-east-1, sa-east-1',
  },
  azure: {
    config: [
      { key: 'tenantId', required: true, example: '00000000-0000-0000-0000-000000000000', pattern: UUID, fixed: true },
      { key: 'subscriptionId', required: true, example: '00000000-0000-0000-0000-000000000000', pattern: UUID, fixed: true },
      { key: 'clientId', required: true, example: '00000000-0000-0000-0000-000000000000', pattern: UUID },
      { key: 'stateResourceGroup', required: true, example: 'orkstage-state', fixed: true },
      { key: 'stateStorageAccount', required: true, example: 'orkstagestate1234', pattern: '^[a-z0-9]{3,24}$', fixed: true },
      { key: 'stateContainer', required: false, example: 'orkstage-tfstate', defaultValue: 'orkstage-tfstate', fixed: true },
    ],
    credentialFields: ['clientSecret'],
    regionsExample: 'eastus, brazilsouth',
  },
  gcp: {
    config: [
      { key: 'projectId', required: true, example: 'acme-prod', pattern: '^[a-z][a-z0-9-]{4,28}[a-z0-9]$', fixed: true },
      { key: 'stateBucket', required: true, example: 'acme-prod-orkstage-tfstate', fixed: true },
    ],
    credentialFields: ['client_email', 'private_key', 'project_id'],
    regionsExample: 'us-central1, southamerica-east1',
  },
  oci: {
    config: [
      { key: 'tenancyOcid', required: true, example: 'ocid1.tenancy.oc1..aaaa', pattern: OCID, fixed: true },
      { key: 'userOcid', required: true, example: 'ocid1.user.oc1..aaaa', pattern: OCID },
      { key: 'fingerprint', required: true, example: '12:34:56:78:9a:bc:de:f0:12:34:56:78:9a:bc:de:f0', pattern: '^([0-9a-f]{2}:){15}[0-9a-f]{2}$' },
      { key: 'compartmentOcid', required: true, example: 'ocid1.compartment.oc1..aaaa', pattern: OCID, fixed: true },
      { key: 'namespace', required: true, example: 'axabcdefghij', fixed: true },
      { key: 'stateBucket', required: true, example: 'orkstage-tfstate', fixed: true },
      { key: 'vaultOcid', required: false, example: 'ocid1.vault.oc1..aaaa' },
      { key: 'keyOcid', required: false, example: 'ocid1.key.oc1..aaaa' },
    ],
    credentialFields: ['privateKey', 'stateAccessKeyId', 'stateSecretAccessKey'],
    regionsExample: 'us-ashburn-1, sa-saopaulo-1',
  },
  digitalocean: {
    config: [
      { key: 'stateBucket', required: true, example: 'acme-orkstage-tfstate', fixed: true },
      { key: 'stateRegion', required: true, example: 'nyc3', fixed: true },
    ],
    credentialFields: ['token', 'spacesAccessKeyId', 'spacesSecretAccessKey'],
    regionsExample: 'nyc3, sfo3',
  },
  vultr: {
    config: [
      { key: 'stateBucket', required: true, example: 'acme-orkstage-tfstate', fixed: true },
      { key: 'stateEndpoint', required: true, example: 'ewr1.vultrobjects.com', fixed: true },
    ],
    credentialFields: ['apiKey', 'stateAccessKeyId', 'stateSecretAccessKey'],
    regionsExample: 'ewr, sao',
  },
  coreweave: {
    config: [
      { key: 'clusterName', required: false, example: 'acme-gpu' },
      { key: 'zone', required: false, example: 'US-EAST-04A' },
      { key: 'stateBucket', required: true, example: 'acme-orkstage-tfstate', fixed: true },
      { key: 'stateEndpoint', required: false, example: 'https://cwobject.com', defaultValue: 'https://cwobject.com', fixed: true },
      { key: 'ingressDomain', required: false, example: 'acme-gpu.coreweave.app' },
      { key: 'ingressClassName', required: false, example: 'traefik' },
      { key: 'clusterIssuer', required: false, example: 'letsencrypt-prod' },
    ],
    credentialFields: ['token', 'stateAccessKeyId', 'stateSecretAccessKey', 'kubeconfig'],
    regionsExample: 'US-EAST-04A',
  },
  magalu: {
    config: [
      { key: 'stateBucket', required: true, example: 'acme-orkstage-tfstate', fixed: true },
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
      { key: 'ownerId', required: true, example: 'tea-abc123', pattern: '^(tea|usr)-[a-z0-9]+$', fixed: true },
      { key: 'registryCredentialId', required: false, example: 'rgc-abc123' },
    ],
    credentialFields: ['apiKey'],
    regionsExample: 'oregon, virginia',
  },
  supabase: {
    config: [{ key: 'organizationId', required: true, example: 'acme-org', fixed: true }],
    credentialFields: ['token'],
    regionsExample: 'us-east-1, sa-east-1',
  },
  mock: { config: [], credentialFields: [], regionsExample: 'us-east-1, eu-west-1' },
};

/**
 * Problems with a target's config that the API rejects before anything reaches the provider:
 * values that do not match their field's pattern, and (AWS) a deployment role that lives in another
 * account than the target's. Required fields are checked by the forms and by the adapter's
 * validation, since emulator targets legitimately leave some out.
 */
export function providerConfigIssues(provider: Provider, config: Record<string, unknown>): string[] {
  const issues: string[] = [];
  for (const f of PROVIDER_FORMS[provider].config) {
    const v = config[f.key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') issues.push(`${f.key} must be text.`);
    else if (f.pattern && !new RegExp(f.pattern).test(v)) issues.push(`${f.key} does not look right (for example ${f.example}).`);
  }
  if (provider === 'aws' && typeof config.roleArn === 'string' && typeof config.accountId === 'string') {
    const account = /^arn:aws[a-z-]*:iam::(\d{12}):/.exec(config.roleArn)?.[1];
    if (account && account !== config.accountId) issues.push(`roleArn is in account ${account}, but accountId is ${config.accountId}.`);
  }
  return issues;
}

/** Config keys of a provider that cannot change after the target is created. */
export function fixedConfigKeys(provider: Provider): string[] {
  return PROVIDER_FORMS[provider].config.filter((f) => f.fixed).map((f) => f.key);
}
