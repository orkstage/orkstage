# @orkstage/cloud-oci

Oracle Cloud Infrastructure provider for OrkStage. Resources are created with the OpenTofu
modules in `orkstage-modules/modules/oci`, one isolated state per resource, kept in an Object
Storage bucket of your tenancy through the S3 compatibility API. Identity, health, secrets and
actions use the OCI REST APIs with signed requests (OCI HTTP Signature, rsa-sha256).

One cloud target is one compartment in one tenancy. Regions are OCI region identifiers such as
`us-ashburn-1` or `sa-saopaulo-1`. Only the commercial realm (`oc1`, `oraclecloud.com`) is
supported.

## Setup

### 1. API user and signing key

Create a user (or use an existing one) in a group that has the permissions listed below, then
give it an API signing key:

```sh
oci setup keys                       # writes ~/.oci/oci_api_key.pem and oci_api_key_public.pem
oci iam user api-key upload --user-id <user OCID> --key-file ~/.oci/oci_api_key_public.pem
```

The upload prints the key fingerprint. The private key must not have a passphrase.

### 2. State bucket and S3 compatibility key

OpenTofu state lives in a bucket you create once. OrkStage never creates it. Buckets reached
through the S3 compatibility API must be in the compartment designated for it (the root
compartment unless you changed it with `oci os ns update-metadata`).

```sh
oci os ns get                                                # your Object Storage namespace
oci os bucket create --compartment-id <S3 designated compartment OCID> \
  --name orkstage-state --versioning Enabled
oci iam customer-secret-key create --user-id <user OCID> --display-name orkstage-state
```

The customer secret key output has an `id` (the access key id) and a `key` (the secret access
key, shown only once).

### 3. Credential secret

Store one JSON object in the secret store and point the target `credentialRef` at it
(`env://NAME` or `aws-sm://name`):

```json
{
  "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "stateAccessKeyId": "<customer secret key id>",
  "stateSecretAccessKey": "<customer secret key>"
}
```

| Field | What it is |
|---|---|
| `privateKey` | PEM private key of the API signing key (PKCS#1 or PKCS#8, no passphrase) |
| `stateAccessKeyId` | Customer secret key id, used only for the state bucket |
| `stateSecretAccessKey` | Customer secret key value, used only for the state bucket |

The private key reaches OpenTofu only as `TF_VAR_oci_private_key` in the runner environment, read
by a sensitive root variable. The state keys reach it only as `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` for the S3 backend. None of them is written to the configuration.

### 4. Target configuration

Non secret settings stored on the target (`target.config`):

| Field | Required | What it is |
|---|---|---|
| `tenancyOcid` | yes | Tenancy OCID |
| `userOcid` | yes | OCID of the API user |
| `fingerprint` | yes | Fingerprint of the API signing key |
| `compartmentOcid` | yes | Compartment where resources are created (the tenancy OCID for the root compartment) |
| `namespace` | yes | Object Storage namespace (`oci os ns get`) |
| `stateBucket` | yes | Existing bucket for OpenTofu state |
| `vaultOcid` | no | Vault for generated database credentials |
| `keyOcid` | no | AES master encryption key in that vault |

Set `vaultOcid` and `keyOcid` together. Without them, every PostgreSQL database creates its own
vault and software key; validation shows a warning, because OCI keeps a deleted vault in a
pending deletion state for at least 7 days. A shared vault can be created with:

```sh
oci kms management vault create --compartment-id <compartment OCID> --display-name orkstage --vault-type DEFAULT
oci kms management key create --compartment-id <compartment OCID> --display-name orkstage \
  --key-shape '{"algorithm":"AES","length":32}' --protection-mode SOFTWARE \
  --endpoint <vault management endpoint>
```

Validation checks the configuration format, signs a request that reads the compartment (the
compartment name becomes the target identity), and checks that the state bucket answers.

## Permissions

Policies for the group of the API user, with `<c>` the target compartment:

```
Allow group OrkStage to read compartments in tenancy
Allow group OrkStage to manage virtual-network-family in compartment <c>
Allow group OrkStage to manage compute-container-family in compartment <c>
Allow group OrkStage to manage load-balancers in compartment <c>
Allow group OrkStage to manage postgres-db-systems in compartment <c>
Allow group OrkStage to manage postgres-backups in compartment <c>
Allow group OrkStage to manage postgres-configurations in compartment <c>
Allow group OrkStage to read postgres-work-requests in compartment <c>
Allow group OrkStage to manage redis-family in compartment <c>
Allow group OrkStage to manage object-family in compartment <c>
Allow group OrkStage to manage vaults in compartment <c>
Allow group OrkStage to manage keys in compartment <c>
Allow group OrkStage to manage secret-family in compartment <c>
Allow service objectstorage-<region> to manage object-family in compartment <c>
```

The state bucket also needs `manage objects` for the group in the S3 designated compartment. The
last statement is only needed for bucket expiry rules (`retentionDays`). With a shared vault,
`use vaults` and `use keys` on that vault are enough instead of `manage`.

## Capabilities

| Kind | Capability | Module | Notes |
|---|---|---|---|
| `network` | `vcn` (default) | `network` | VCN, internet gateway, service gateway, NAT gateway when `natGateway`, one public and one private regional subnet with security lists |
| `compute.container-service` | `container-instances` (default) | `container-service` | One container instance per replica on `CI.Standard.E4.Flex`, spread across availability domains; NSG for the service port; registers each instance in its load balancer backend set; `restart` action; logs |
| `database.postgresql` | `oci-postgresql` (default) | `postgres` | OCI Database with PostgreSQL on `PostgreSQL.VM.Standard.E5.Flex`; credentials JSON in a Vault secret (`secret_ref`) |
| `cache.redis` | `oci-cache` (default) | `redis` | OCI Cache, non sharded Valkey 7.2 cluster, TLS on port 6379 |
| `object-storage` | `object-storage` (default) | `object-storage` | Bucket with versioning, tier (Archive bucket or Infrequent Access auto tiering), optional public read and expiry rule |
| `ingress` | `flexible-load-balancer` (default) | `ingress` | Public flexible load balancer, one backend set per route, longest prefix path routing on port 80 |

Sizes:

| Size | PostgreSQL (OCPU, memory) | Cache node memory |
|---|---|---|
| micro | 1, 16 GB | 2 GB |
| small | 2, 32 GB | 4 GB |
| medium | 4, 64 GB | 8 GB |
| large | 8, 128 GB | 16 GB |
| xlarge | 16, 256 GB | |

Container CPU is converted to whole OCPUs (1 OCPU is 2 vCPUs, at least 1), and memory is rounded
up to whole GB within 1 to 64 GB per OCPU.

Services receive their dependencies as `<ID>_HOST`, `<ID>_PORT`, `<ID>_URL`, `<ID>_BUCKET` and
`<ID>_ENDPOINT`. Container instances cannot inject secrets, so a dependency's credentials arrive
as `<ID>_CREDENTIALS_REF`, the Vault secret OCID; the application reads it with its own identity
(for example a resource principal with `read secret-bundles`). Resources on other providers can
read the same secret through `readSecret` (fields `username`, `password`, `host`, `port`,
`database`, `url`).

## Known limits

- Container instances have no autoscaling; `replicas` is a fixed instance count.
- A new image or setting replaces the container instances. New instances start before the old
  ones stop, and the plan treats this as a routine rollout.
- Private registry credentials for images are not configured; use public images or a registry
  the instances can reach without credentials.
- PostgreSQL storage grows automatically, so `storageGiB` only feeds estimates. `publicAccess`
  is not supported (endpoints are private to the VCN). High availability adds a second node on
  regionally durable storage. The generated password is kept in OpenTofu state and in the Vault
  secret, never in outputs.
- OCI Cache has no password; access is limited to the VCN.
- Buckets must be empty before they are deleted.
- The load balancer listens on HTTP port 80; TLS certificates are not managed yet. In
  production, delete protection is on.
- State locking uses no lock file: the platform runs one operation per resource at a time.
