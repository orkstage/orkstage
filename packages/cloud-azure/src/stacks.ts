// SPDX-License-Identifier: AGPL-3.0-only
import { ProviderError, byKind, envKey, needKind, type ProviderContext, type ResourceOutputs, type ResourceRequest } from '@orkstage/cloud-core';
import type { ModuleCall, RootParts } from '@orkstage/cloud-tofu';
import { fitName, sha256 } from '@orkstage/domain';
import { azureConfig } from './config.js';

const MODULE_BY_CAPABILITY: Record<string, string> = {
  vnet: 'network',
  'container-apps': 'container-service',
  'flexible-server': 'postgres',
  'managed-redis': 'redis',
  'blob-storage': 'object-storage',
  'front-door': 'ingress',
};

/** Capabilities answered without infrastructure of their own (see `virtualIngress`). */
export const VIRTUAL_CAPABILITIES = new Set(['container-apps-ingress']);

/** Resource providers each module needs registered in the subscription. */
export const RESOURCE_PROVIDERS: Record<string, string[]> = {
  network: ['Microsoft.Network', 'Microsoft.App', 'Microsoft.OperationalInsights'],
  'compute.container-service': ['Microsoft.App', 'Microsoft.OperationalInsights', 'Microsoft.ManagedIdentity'],
  'database.postgresql': ['Microsoft.DBforPostgreSQL', 'Microsoft.KeyVault', 'Microsoft.Network'],
  'cache.redis': ['Microsoft.Cache', 'Microsoft.KeyVault', 'Microsoft.Network'],
  'object-storage': ['Microsoft.Storage'],
  ingress: ['Microsoft.Cdn'],
};

const POSTGRES_SKU: Record<string, string> = {
  micro: 'B_Standard_B1ms',
  small: 'B_Standard_B2s',
  medium: 'GP_Standard_D2ds_v5',
  large: 'GP_Standard_D4ds_v5',
  xlarge: 'GP_Standard_D8ds_v5',
};

const REDIS_SKU: Record<string, string> = {
  micro: 'Balanced_B0',
  small: 'Balanced_B1',
  medium: 'Balanced_B3',
  large: 'Balanced_B5',
};

/** Storage sizes a flexible server accepts, in MiB. */
const POSTGRES_STORAGE_MB = [32768, 65536, 131072, 262144, 524288, 1048576, 2097152, 4193280, 4194304, 8388608, 16777216, 33553408];

type Spec = Record<string, unknown>;

/**
 * Name for resources whose name is a global DNS label (Key Vault, PostgreSQL, Redis, Front Door
 * endpoint): the readable name plus a hash of subscription and name, within `max` characters.
 */
export function globalName(name: string, subscriptionId: string, max: number): string {
  const hash = sha256(`${subscriptionId}/${name}`).slice(0, 6);
  return `${name.slice(0, max - 7).replace(/-+$/, '')}-${hash}`;
}

/** Storage account names: 3 to 24 lowercase letters and digits, globally unique. */
export function storageAccountName(name: string, subscriptionId: string): string {
  return `${name.replace(/[^a-z0-9]/g, '').slice(0, 18)}${sha256(`${subscriptionId}/${name}`).slice(0, 6)}`;
}

export const resourceGroupFor = (name: string) => fitName(`${name}-rg`, 90);

/** Azure tag names may not contain `<>%&\?/`; values are limited to 256 characters. */
export function azureTags(tags: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.replace(/[<>%&\\?/]/g, '_').slice(0, 512), String(v).slice(0, 256)]));
}

/** Container Apps (Consumption) sizes: vCPU in 0.25 steps up to 4, memory twice the vCPU. */
export function containerSize(cpu: number, memoryMiB: number): { cpu: number; memory: string } {
  const wanted = Math.max(cpu, memoryMiB / 2048);
  const vcpu = Math.min(4, Math.max(0.25, Math.ceil(wanted * 4) / 4));
  return { cpu: vcpu, memory: `${vcpu * 2}Gi` };
}

const KEY_VAULT_SECRET = /^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/secrets\/[A-Za-z0-9-]{1,127}(\/[0-9a-f]{32})?\/?$/;

/** True for a Key Vault secret id (`https://<vault>.vault.azure.net/secrets/<name>`). */
export const isKeyVaultSecretId = (ref: string) => KEY_VAULT_SECRET.test(ref);

/** Module and inputs for one logical resource. */
export function moduleCall(ctx: ProviderContext, req: ResourceRequest): ModuleCall {
  const module = MODULE_BY_CAPABILITY[req.capability];
  if (!module) {
    throw new ProviderError('AZURE_CAPABILITY_NOT_IMPLEMENTED', `${req.capability} is not implemented by the Azure adapter. Choose another implementation.`, 'VALIDATION_ERROR', 'azure');
  }
  const { subscriptionId } = azureConfig(ctx.target);
  const spec = req.spec as Spec;
  const deps = req.dependencyOutputs;
  const production = req.tags['platform:environment'] === 'production';
  const common = { resource_group_name: resourceGroupFor(req.name), location: ctx.region, tags: azureTags(req.tags) };

  switch (module) {
    case 'network': {
      const octet = 16 + (parseInt(sha256(req.name).slice(0, 4), 16) % 200);
      return {
        module,
        inputs: {
          ...common,
          name: fitName(req.name, 64),
          environment_name: fitName(req.name, 32),
          cidr: `10.${octet}.0.0/16`,
          zone_redundant: Number(spec.availabilityZones ?? 1) > 1,
          nat_gateway: Boolean(spec.natGateway),
        },
      };
    }
    case 'container-service':
      return { module, inputs: { ...common, ...containerInputs(ctx, req, spec, deps) } };
    case 'postgres': {
      const publicAccess = Boolean(spec.publicAccess);
      const network = publicAccess ? undefined : needKind('azure', deps, 'network', `${req.resourceId} (private PostgreSQL)`);
      const backup = (spec.backup ?? {}) as { enabled?: boolean; retentionDays?: number };
      const ha = spec.highAvailability === 'zone-redundant' ? 'ZoneRedundant' : spec.highAvailability === 'same-zone' ? 'SameZone' : 'none';
      let sku = POSTGRES_SKU[String(spec.size ?? 'small')] ?? POSTGRES_SKU.small!;
      if (ha !== 'none' && sku.startsWith('B_')) {
        sku = POSTGRES_SKU.medium!;
        ctx.log?.('warn', `${req.resourceId}: high availability needs the General Purpose tier; using ${sku}.`);
      }
      const storageMb = POSTGRES_STORAGE_MB.find((mb) => mb >= Number(spec.storageGiB ?? 32) * 1024) ?? POSTGRES_STORAGE_MB.at(-1)!;
      return {
        module,
        inputs: {
          ...common,
          name: globalName(req.name, subscriptionId, 63),
          vault_name: globalName(req.name, subscriptionId, 24),
          engine_version: String(spec.version ?? '17'),
          sku_name: sku,
          storage_mb: storageMb,
          high_availability: ha,
          backup_retention_days: Math.min(35, Math.max(7, backup.enabled === false ? 7 : Number(backup.retentionDays ?? 7))),
          production,
          delegated_subnet_id: network ? String(network.postgres_subnet_id) : '',
          vnet_id: network ? String(network.network_id) : '',
        },
      };
    }
    case 'redis': {
      const network = byKind(deps, 'network');
      return {
        module,
        inputs: {
          ...common,
          name: globalName(req.name, subscriptionId, 60),
          vault_name: globalName(req.name, subscriptionId, 24),
          sku_name: REDIS_SKU[String(spec.size ?? 'micro')] ?? REDIS_SKU.micro,
          high_availability: Number(spec.replicas ?? 0) > 0 || production,
          production,
          private_subnet_id: network ? String(network.private_subnet_id ?? '') : '',
          dns_zone_id: network ? String(network.redis_dns_zone_id ?? '') : '',
        },
      };
    }
    case 'object-storage':
      return {
        module,
        inputs: {
          ...common,
          account_name: storageAccountName(req.name, subscriptionId),
          container_name: fitName(req.name, 63),
          tier: spec.tier ?? 'standard',
          versioning: Boolean(spec.versioning),
          public_access: Boolean(spec.publicAccess),
          retention_days: spec.retentionDays ?? null,
          production,
        },
      };
    case 'ingress': {
      const routes = ((spec.routes ?? []) as { service: string; pathPrefix?: string; healthCheckPath?: string }[]).map((r) => ({
        service: r.service,
        path_prefix: r.pathPrefix ?? '/',
        health_path: r.healthCheckPath ?? '/',
      }));
      return { module, inputs: { ...common, name: fitName(req.name, 90), endpoint_name: globalName(req.name, subscriptionId, 46), routes } };
    }
    default:
      throw new ProviderError('AZURE_CAPABILITY_NOT_IMPLEMENTED', `${req.capability} is not implemented.`, 'VALIDATION_ERROR', 'azure');
  }
}

function containerInputs(ctx: ProviderContext, req: ResourceRequest, spec: Spec, deps: Record<string, ResourceOutputs>): Record<string, unknown> {
  const network = byKind(deps, 'network');
  const ingress = byKind(deps, 'ingress');
  const port = spec.port === undefined || spec.port === null ? null : Number(spec.port);
  const environment: Record<string, string> = port ? { PORT: String(port) } : {};
  const secrets: Record<string, { secret_id: string; vault_id: string }> = {};
  const storageAccountIds: string[] = [];
  for (const [id, out] of Object.entries(deps)) {
    if (['network', 'container-registry', 'ingress', 'dns'].includes(String(out.kind))) continue;
    const key = envKey(id);
    if (out.host) environment[`${key}_HOST`] = String(out.host);
    if (out.port) environment[`${key}_PORT`] = String(out.port);
    if (out.url) environment[`${key}_URL`] = String(out.url);
    if (out.queue_url) environment[`${key}_URL`] = String(out.queue_url);
    if (out.bucket) environment[`${key}_BUCKET`] = String(out.bucket);
    if (out.endpoint) environment[`${key}_ENDPOINT`] = String(out.endpoint);
    if (out.storage_account_id) storageAccountIds.push(String(out.storage_account_id));
    const ref = out.secret_ref ? String(out.secret_ref) : '';
    if (ref && isKeyVaultSecretId(ref) && out.key_vault_id) {
      secrets[`${key}_CREDENTIALS`] = { secret_id: ref, vault_id: String(out.key_vault_id) };
    } else if (ref) {
      // Another provider's reference: Container Apps cannot resolve it natively.
      environment[`${key}_CREDENTIALS_REF`] = ref;
      ctx.log?.('warn', `${id} publishes credentials outside Azure Key Vault; ${req.resourceId} receives only the reference.`);
    }
  }
  const originGroups = ingress?.origin_groups ? (JSON.parse(String(ingress.origin_groups)) as Record<string, string>) : {};
  const size = containerSize(Number(spec.cpu ?? 0.25), Number(spec.memoryMiB ?? 512));
  const a = spec.autoscaling as { minReplicas: number; maxReplicas: number; targetCpuPercent: number } | undefined;
  return {
    name: fitName(req.name, 32),
    image: spec.image,
    cpu: size.cpu,
    memory: size.memory,
    replicas: Number(spec.replicas ?? 1),
    port,
    public: Boolean(spec.public),
    health_path: String(spec.healthCheckPath ?? ''),
    environment,
    secrets,
    storage_account_ids: storageAccountIds,
    environment_id: network?.container_app_environment_id ? String(network.container_app_environment_id) : '',
    log_workspace_id: network?.log_workspace_id ? String(network.log_workspace_id) : '',
    origin_group_id: originGroups[req.resourceId] ?? '',
    autoscaling: a ? { min_replicas: a.minReplicas, max_replicas: a.maxReplicas, target_cpu_percent: a.targetCpuPercent } : null,
  };
}

/**
 * Outputs of the built in Container Apps ingress: nothing to create, each routed service keeps
 * its own HTTPS address. The routes are recorded so the console can show them.
 */
export function virtualIngress(req: ResourceRequest): ResourceOutputs {
  const routes = ((req.spec.routes ?? []) as { service: string; pathPrefix?: string }[]).map((r) => ({ service: r.service, pathPrefix: r.pathPrefix ?? '/' }));
  return { kind: 'ingress', mode: 'container-apps-builtin', routes: JSON.stringify(routes), tls: true };
}

/** Provider blocks for one resource. Credentials come from ARM_* variables, never from here. */
export function rootParts(_ctx: ProviderContext, req: ResourceRequest): RootParts {
  const production = req.tags['platform:environment'] === 'production';
  return {
    requiredProviders: {
      azurerm: { source: 'hashicorp/azurerm', version: '~> 5.0' },
      random: { source: 'hashicorp/random', version: '~> 3.7' },
      time: { source: 'hashicorp/time', version: '~> 0.13' },
    },
    providers: {
      azurerm: {
        features: {
          resource_group: { prevent_deletion_if_contains_resources: production },
          key_vault: { purge_soft_delete_on_destroy: !production, recover_soft_deleted_key_vaults: true },
          log_analytics_workspace: { permanently_delete_on_destroy: !production },
          // Storage resources here are managed through ARM only; shared keys stay disabled.
          storage: { data_plane_available: false },
        },
        resource_provider_registrations: 'none',
        resource_providers_to_register: RESOURCE_PROVIDERS[req.serviceKind] ?? [],
        storage_use_azuread: true,
        use_cli: false,
      },
    },
  };
}
