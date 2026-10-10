import type { CloudTarget, TargetValidationCheck } from '@orkstage/cloud-core';

/** Non secret Azure target configuration stored on the cloud target. */
export interface AzureTargetConfig {
  /** Microsoft Entra tenant of the service principal. */
  tenantId: string;
  subscriptionId: string;
  /** Application (client) id of the service principal. Its secret lives behind credentialRef. */
  clientId: string;
  /** Resource group of the state storage account. */
  stateResourceGroup: string;
  /** Storage account holding OpenTofu state. Must exist before deploying. */
  stateStorageAccount: string;
  /** Blob container for state inside that account. */
  stateContainer: string;
}

/** Fields of the credential secret behind `credentialRef`. */
export interface AzureCredentials extends Record<string, string> {
  clientSecret: string;
}

export const DEFAULT_STATE_CONTAINER = 'orkstage-tfstate';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_ACCOUNT = /^[a-z0-9]{3,24}$/;
const CONTAINER = /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const RESOURCE_GROUP = /^[\w().-]{1,90}$/;

export function azureConfig(target: CloudTarget): AzureTargetConfig {
  const c = target.config as Partial<AzureTargetConfig>;
  return {
    tenantId: String(c.tenantId ?? ''),
    subscriptionId: String(c.subscriptionId ?? ''),
    clientId: String(c.clientId ?? ''),
    stateResourceGroup: String(c.stateResourceGroup ?? ''),
    stateStorageAccount: String(c.stateStorageAccount ?? ''),
    stateContainer: String(c.stateContainer || DEFAULT_STATE_CONTAINER),
  };
}

/** Format checks of the target configuration; no network calls. */
export function configChecks(target: CloudTarget): TargetValidationCheck[] {
  const c = azureConfig(target);
  const checks: TargetValidationCheck[] = [];
  const err = (name: string, message: string) => checks.push({ name, status: 'error', message });
  if (!GUID.test(c.tenantId)) err('Tenant id', 'tenantId must be the directory (tenant) id, a GUID.');
  if (!GUID.test(c.subscriptionId)) err('Subscription id', 'subscriptionId must be a subscription GUID.');
  if (!GUID.test(c.clientId)) err('Client id', 'clientId must be the application (client) id of the service principal, a GUID.');
  if (!RESOURCE_GROUP.test(c.stateResourceGroup)) err('State resource group', 'stateResourceGroup must name the resource group of the state storage account.');
  if (!STORAGE_ACCOUNT.test(c.stateStorageAccount)) err('State storage account', 'stateStorageAccount must be 3 to 24 lowercase letters and digits.');
  if (!CONTAINER.test(c.stateContainer)) err('State container', 'stateContainer must be 3 to 63 lowercase letters, digits and single hyphens.');
  if (!checks.length) checks.push({ name: 'Target configuration', status: 'ok', message: 'Tenant, subscription, client and state storage are well formed.' });
  return checks;
}
