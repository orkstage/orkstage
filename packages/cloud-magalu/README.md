# @orkstage/cloud-magalu

Magalu Cloud provider for OrkStage. Resources are created with the
[MagaluCloud/mgc](https://search.opentofu.org/provider/magalucloud/mgc/latest) OpenTofu provider
(pinned to `~> 0.56.0`), one isolated state per resource, kept in an Object Storage bucket in your
own tenant. Health, existence checks and restarts use the regional REST API
(`https://api.magalu.cloud/<region>/...`, header `X-API-Key`).

Regions: `br-se1` and `br-ne1`.

## Credentials

The target's `credentialRef` (`env://NAME` or `aws-sm://name`) must resolve to this JSON:

```json
{ "apiKey": "...", "stateAccessKeyId": "...", "stateSecretAccessKey": "..." }
```

| Field | What it is |
| --- | --- |
| `apiKey` | API key created in ID Magalu (id.magalu.com/api-keys). Used by the OpenTofu provider and the REST API. |
| `stateAccessKeyId` | Object Storage key pair ID of an API key with Object Storage access. |
| `stateSecretAccessKey` | Object Storage key pair secret of the same key. |

The key pair reads and writes OpenTofu state and is also given to the provider for bucket
operations. Secrets reach OpenTofu only as runner environment variables: `TF_VAR_mgc_api_key`,
`TF_VAR_mgc_key_pair_id` and `TF_VAR_mgc_key_pair_secret` (the provider takes these values from
configuration only, so they are sensitive root variables), plus `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` for the S3 backend.

## Target configuration

| Field | Required | Description |
| --- | --- | --- |
| `stateBucket` | yes | Object Storage bucket for OpenTofu state, in the region you deploy to. |
| `sshKeyName` | no | Existing SSH key for service VMs. Without it, each service gets its own generated key (the private key stays in state and is never output). |

## State storage

Create the bucket before validating the target (OrkStage never creates it):

```sh
mgc object-storage buckets create acme-orkstage-tfstate
```

Create it in the target region (`br-se1` or `br-ne1`), keep it private and turn on versioning in
the console. State is reached at `https://<region>.magaluobjects.com` with path style addressing.
S3 lock files are off: Magalu Object Storage support for conditional writes is not documented, and
the platform already runs one operation per resource at a time.

## Minimum permissions

When creating the API key, grant read and write access to Network (VPC), Virtual Machines,
SSH Keys, DBaaS, Load Balancer and Object Storage. A target that only deploys some kinds can leave
the others out.

## Capabilities

| Kind | Capability | Module | Notes |
| --- | --- | --- | --- |
| `network` | `vpc` (default) | `network` | VPC, subnet pool, one IPv4 subnet and an internal security group. |
| `compute.container-service` | `vm-docker` (default) | `container-service` | One VM per replica, Docker installed and started by cloud-init. Machine type is the smallest Balanced Value type that fits cpu and memory. Public services with more than one replica get a network load balancer on port 80. Action `restart` reboots the VMs. |
| `database.postgresql` | `dbaas-postgres` (default) | `postgres` | DBaaS instance, or a Multi AZ cluster for `zone-redundant`. Private address only. `secret_ref` is `mgc-db://<name>/<id>`. |
| `object-storage` | `object-storage` (default) | `object-storage` | Private bucket with optional versioning. |

`secret_ref` for databases: DBaaS does not return the master password, so the adapter reads the
password generated in that database's OpenTofu state (in your bucket) when a resource on another
provider needs it. Inside Magalu VMs, services receive the reference as
`<ID>_CREDENTIALS_REF`, not the value.

## Known limits

- No cache.redis, ingress or Kubernetes capability. Magalu Cloud has no managed Redis in the
  provider. The network load balancer needs its targets at creation time and has no separate target
  resource, while OrkStage creates an ingress before the services it routes to, so load balancing is
  built into `vm-docker` instead. Running containers on Magalu Kubernetes would need a second
  provider and is left for later.
- The network load balancer is TCP only (no path routing, no TLS termination here) and is marked
  experimental by Magalu Cloud.
- No autoscaling: replicas is a fixed VM count. Changing the image or environment replaces the VMs.
- Images must be pullable without registry credentials.
- VMs get a public IPv4 each so they can pull images; inbound traffic is limited to the service
  port (from anywhere for public services, from the VPC otherwise). `natGateway` is not applied.
- DBaaS: `publicAccess` and same zone HA are not offered; backups are always on (1 to 35 days); the
  requested PostgreSQL version must be active in the region (the module fails with the list of
  active versions otherwise).
- Object Storage: `publicAccess`, `tier` and `retentionDays` are not applied; a bucket must be empty
  before it is destroyed.
- Magalu tags are tenant wide and authoritative per resource, so `req.tags` are not applied.
