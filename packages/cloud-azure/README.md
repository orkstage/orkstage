# @orkstage/cloud-azure

Microsoft Azure provider for OrkStage. Resources are created with OpenTofu (`hashicorp/azurerm`
5.x) in a throwaway runner container, one isolated state per resource, kept in a Blob container
in your own subscription. Health, secrets, logs and the restart action use the Azure Resource
Manager, Key Vault and Log Analytics REST APIs.

## How OrkStage signs in

OrkStage uses a service principal with a client secret. The secret is read from the target's
`credentialRef` (`env://NAME` or `aws-sm://name`) when needed and reaches OpenTofu only as
runner environment variables (`ARM_TENANT_ID`, `ARM_CLIENT_ID`, `ARM_CLIENT_SECRET`,
`ARM_SUBSCRIPTION_ID`). It is never written to configuration, state keys or logs.

Workload identity federation (no stored secret) is planned as a later option.

### Credential secret

A JSON object:

```json
{ "clientSecret": "<client secret value>" }
```

A plain string is also accepted and is taken as `clientSecret`.

### Target configuration

| Field | Required | Description |
| --- | --- | --- |
| `tenantId` | yes | Directory (tenant) id of the service principal |
| `subscriptionId` | yes | Subscription that receives the resources |
| `clientId` | yes | Application (client) id of the service principal |
| `stateResourceGroup` | yes | Resource group of the state storage account |
| `stateStorageAccount` | yes | Storage account for OpenTofu state (3 to 24 lowercase letters and digits) |
| `stateContainer` | no | Blob container for state, default `orkstage-tfstate` |

Regions are Azure locations such as `eastus`, `brazilsouth` or `westeurope`. List the ones this
target may use in `allowedRegions`.

## Setup

Run these once per subscription with the Azure CLI, signed in as someone who can create role
assignments.

```sh
SUB=<subscription id>
LOCATION=eastus
az account set --subscription "$SUB"

# Service principal for OrkStage
az ad sp create-for-rbac --name orkstage-deployer --role Contributor --scopes "/subscriptions/$SUB"
# Note appId (clientId), password (clientSecret) and tenant (tenantId).
APP_ID=<appId from the output>
az role assignment create --assignee "$APP_ID" --role "User Access Administrator" --scope "/subscriptions/$SUB"

# State storage: versioned, no shared keys, Microsoft Entra access only
az group create --name orkstage-state --location "$LOCATION"
az storage account create --name <stateaccount> --resource-group orkstage-state --location "$LOCATION" \
  --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --allow-blob-public-access false \
  --allow-shared-key-access false
az storage account blob-service-properties update --account-name <stateaccount> --resource-group orkstage-state \
  --enable-versioning true --enable-delete-retention true --delete-retention-days 30
az storage container create --name orkstage-tfstate --account-name <stateaccount> --auth-mode login
az role assignment create --assignee "$APP_ID" --role "Storage Blob Data Contributor" \
  --scope "/subscriptions/$SUB/resourceGroups/orkstage-state/providers/Microsoft.Storage/storageAccounts/<stateaccount>"
```

OrkStage never creates the state container: target validation reports it as missing until it
exists.

### Permissions

| Role | Scope | Why |
| --- | --- | --- |
| Contributor | subscription | Create resource groups and every resource, register resource providers |
| User Access Administrator | subscription | Role assignments (Key Vault and storage access for apps, Key Vault access for OrkStage) and production delete locks |
| Storage Blob Data Contributor | state storage account | Read and write OpenTofu state |

Owner on the subscription covers the first two. OrkStage gives itself Key Vault Secrets Officer on
the vaults it creates, so it can write generated credentials and read them back for resources on
other providers.

Resource providers are registered on first use (`Microsoft.App`, `Microsoft.OperationalInsights`,
`Microsoft.ManagedIdentity`, `Microsoft.Network`, `Microsoft.DBforPostgreSQL`, `Microsoft.Cache`,
`Microsoft.KeyVault`, `Microsoft.Storage`, `Microsoft.Cdn`). Target validation warns about the
ones not registered yet.

## Capabilities

Every resource gets its own resource group (`<name>-rg`), so destroying it removes everything it
created.

| Kind | Capability | Default | What gets created |
| --- | --- | --- | --- |
| `network` | `vnet` | yes | Virtual network with a delegated Container Apps subnet, a delegated PostgreSQL subnet and a private endpoint subnet, optional NAT gateway, Log Analytics workspace, the Container Apps environment the network's services share, private DNS zone for Redis |
| `compute.container-service` | `container-apps` | yes | Container app with a user assigned identity, external ingress when public, CPU scale rule from `autoscaling`, Key Vault backed secrets for dependencies, Storage Blob Data Contributor on dependent storage accounts; its own environment when there is no network |
| `database.postgresql` | `flexible-server` | yes | Flexible server (private access through the delegated subnet and a private DNS zone), database `app`, Key Vault holding the generated credentials |
| `cache.redis` | `managed-redis` | yes | Azure Managed Redis (private endpoint when there is a network), Key Vault holding the access key |
| `object-storage` | `blob-storage` | yes | Storage account with one container, versioning, soft delete, lifecycle rules for `retentionDays` and the archive tier |
| `ingress` | `container-apps-ingress` | yes | Nothing: each service keeps the HTTPS address of the Container Apps built in ingress |
| `ingress` | `front-door` | no | Front Door Standard profile and endpoint with one route and origin group per routed service; services join their origin group |

Services receive `<ID>_HOST`, `<ID>_PORT`, `<ID>_URL`, `<ID>_BUCKET` and `<ID>_ENDPOINT` for each
dependency, and `<ID>_CREDENTIALS` with the JSON credentials from Key Vault (`username`,
`password`, `host`, `port`, `database`, `url`). `AZURE_CLIENT_ID` points Azure SDKs at the app's
identity for storage access.

Passwords are generated with an ephemeral resource and written through write only attributes, so
PostgreSQL credentials never enter OpenTofu state. Module outputs carry only the Key Vault secret
id (`secret_ref`).

Production resources (`platform:environment` = `production`) get Key Vault purge protection, a
`CanNotDelete` lock on databases and storage accounts, and resource groups that refuse to be
deleted while they still hold resources.

The `restart` action restarts the active revision of a container app. Logs come from the
`ContainerAppConsoleLogs_CL` table of the Log Analytics workspace.

## Known limits

- Container Apps run on the Consumption profile: up to 4 vCPU and 8 GiB per replica, and memory
  is always twice the vCPU, so the size follows the larger of `cpu` and `memoryMiB`.
- Images must be pullable without credentials; private registries are not wired yet.
- The CPU scale rule cannot wake an app from zero, so autoscaled apps keep at least one replica.
- Backups (open item 18): the worker reads a PostgreSQL server's retention, earliest restore point
  and last completed backup through ARM. Azure reports no backup schedule or failed backups there,
  so a missing backup shows as overdue after 26 hours. Not yet verified on a live account.
- PostgreSQL backups cannot be disabled (minimum 7 days). High availability needs the General
  Purpose tier, so `micro` and `small` move to `GP_Standard_D2ds_v5` when HA is requested.
  Private PostgreSQL needs a network in the same placement slot; with `publicAccess` the server
  accepts connections from Azure services only.
- Managed Redis replication is on or off: any `replicas` above zero (or production) turns high
  availability on.
- Credentials published outside Azure Key Vault (another provider's `secret_ref`) reach a
  container app only as `<ID>_CREDENTIALS_REF`.
- Front Door routes are created before the apps behind them; a route answers once its service
  has been deployed and joined its origin group. Only public apps can be origins.
- Zone redundancy of the Container Apps environment (`availabilityZones` above 1) needs a region
  with availability zones.
