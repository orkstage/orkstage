# @orkstage/cloud-vultr

Vultr provider for OrkStage. Resources are created with OpenTofu (provider `vultr/vultr`, `~> 2.30`,
verified with 2.33.1) from the modules in `orkstage-modules/modules/vultr`. Each resource has its
own state file in an Object Storage bucket of your account.

## Target configuration

Non secret settings stored on the cloud target:

| Field | Example | Meaning |
| --- | --- | --- |
| `stateBucket` | `orkstage-state-acme` | Bucket that holds OpenTofu state. It must exist. |
| `stateEndpoint` | `ewr1.vultrobjects.com` | Object Storage hostname of the subscription that owns the bucket, without `https://`. |

Regions are Vultr region ids: `ewr`, `ord`, `sao`, `fra`, `ams`, and so on.

## Credentials

`credentialRef` (`env://NAME` or `aws-sm://name`) must resolve to this JSON object:

```json
{
  "apiKey": "<Vultr API key>",
  "stateAccessKeyId": "<Object Storage access key of the state subscription>",
  "stateSecretAccessKey": "<Object Storage secret key of the state subscription>"
}
```

The runner receives them as `VULTR_API_KEY`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for one
command. They are never written to the OpenTofu configuration.

Validation calls `GET /v2/account` and shows the account name as the identity.

## Minimum permissions

Use the API key of a Vultr user with these permissions: Manage Servers (subscriptions and
provisioning), Manage Firewall, Manage Load Balancers, Manage Object Storage and Manage Managed
Databases. If the key has an access control list of allowed IP addresses, add the addresses of the
OrkStage worker and runner.

## State storage

Create one Object Storage subscription for state and a versioned bucket in it. With the Vultr API
(the key is read from your shell, never pasted into files):

```sh
# Clusters and their hostnames; pick one in your region with deploy = yes.
curl -s -H "Authorization: Bearer $VULTR_API_KEY" https://api.vultr.com/v2/object-storage/clusters
# Tiers offered by that cluster.
curl -s -H "Authorization: Bearer $VULTR_API_KEY" https://api.vultr.com/v2/object-storage/clusters/9/tiers
# The subscription.
curl -s -X POST -H "Authorization: Bearer $VULTR_API_KEY" -H "Content-Type: application/json" \
  -d '{"cluster_id": 9, "tier_id": 5, "label": "orkstage-state"}' https://api.vultr.com/v2/object-storage
# Hostname and keys of the subscription (store the keys in your secret store).
curl -s -H "Authorization: Bearer $VULTR_API_KEY" https://api.vultr.com/v2/object-storage/<id>
```

Then create the bucket with any S3 client, using the subscription keys:

```sh
aws s3api create-bucket --bucket orkstage-state-acme --endpoint-url https://ewr2.vultrobjects.com
aws s3api put-bucket-versioning --bucket orkstage-state-acme \
  --versioning-configuration Status=Enabled --endpoint-url https://ewr2.vultrobjects.com
```

State locking with a lock file is off: conditional writes are not confirmed on Vultr Object
Storage, and OrkStage already runs one operation per resource at a time.

## Capabilities

| Kind | Capability | Module | Notes |
| --- | --- | --- | --- |
| `network` | `vpc` | `network` | One `vultr_vpc` (a /20 in 10.0.0.0/8). |
| `compute.container-service` | `instance-docker` | `container-service` | One cloud compute instance per replica running the image with Docker. Action: `restart`. |
| `database.postgresql` | `managed-postgres` | `postgres` | Managed PostgreSQL in the VPC. `secret_ref` is `vultr-db://<id>`. |
| `cache.redis` | `managed-valkey` | `redis` | Managed Valkey (Redis compatible, TLS). `secret_ref` is `vultr-db://<id>`. |
| `object-storage` | `object-storage` | `object-storage` | One subscription and one bucket. `secret_ref` is `vultr-objstore://<id>`. |
| `ingress` | `load-balancer` | `ingress` | One Vultr load balancer in the VPC for one service. |

### Container service

Each replica is an Ubuntu 24.04 instance on the cheapest `vc2` plan that fits `cpu` and
`memoryMiB` (override with `providerOverrides.vultr.plan`). Cloud init installs Docker and runs the
image with the service environment, `--memory` and `--cpus` limits, and the port published. A
firewall group opens the port to the VPC, and to everyone only when the service is public and no
load balancer routes to it. Changing the image, the environment or the plan replaces the instances,
new ones first.

Credentials of Vultr databases and object storage the service depends on are read by the module
(`vultr_database` and `vultr_object_storage` data sources) and added to the container environment as
`<ID>_URL`, `<ID>_USERNAME`, `<ID>_PASSWORD`, `<ID>_ACCESS_KEY_ID` and `<ID>_SECRET_ACCESS_KEY`. They
travel in the instance user data, which every administrator of the Vultr account can read, and they
are kept in the OpenTofu state. Set `providerOverrides.vultr.injectCredentials: false` to turn this
off; the service then receives `<ID>_CREDENTIALS_REF` only.

The `restart` action reboots every instance; Docker starts the container again.

### Databases

The plan is looked up in `GET /v2/databases/plans` before each apply: the cheapest plan for the
engine and region with at least the memory of the size (micro 1 GB, small 2 GB, medium 4 GB, large
8 GB, xlarge 16 GB) and the right node count (PostgreSQL high availability adds a standby; cache
replicas add standbys, up to 3 nodes). The chosen plan is kept while the size does not change.
Override with `providerOverrides.vultr.plan`, `engineVersion` (Valkey defaults to `7`) and
`timeZone`. Without `publicAccess`, only the VPC range is trusted.

`readSecret` answers `vultr-db://<id>` from `GET /v2/databases/<id>` (public host when there is
one) and `vultr-objstore://<id>` from `GET /v2/object-storage/<id>`, so a frontend on another
provider can be wired to them.

### Ingress

A Vultr load balancer has no path routing and one health check for all attached instances, so an
ingress serves exactly one service: HTTP on port 80 to the service port over the VPC, with the
service `healthCheckPath`. Routes to more than one service, or a `pathPrefix` other than `/`, fail
validation; create one ingress per service. TLS needs a domain that already points at the load
balancer (`providerOverrides.vultr.autoSslDomain`); without it the load balancer serves HTTP only.
Instances are attached through the Vultr API after the service is applied and detached before it
is destroyed.

## Known limits

- No autoscaling: the service runs `max(replicas, autoscaling.minReplicas)` instances.
- The image must be pullable without registry credentials.
- During a rollout the load balancer receives the new instances only after the apply finishes.
- No availability zones and no NAT gateway: `availabilityZones` and `natGateway` are ignored, and
  instances keep a public address for egress (inbound closed by the firewall group).
- Database storage is fixed by the plan (`storageGiB` is not applied); backups are daily and managed
  by Vultr.
- Object Storage tiers are performance tiers: `tier`, `retentionDays` and `publicAccess` are not
  applied, and each resource is a billed subscription.
- Vultr has no deletion protection; production deletes rely on OrkStage approvals.
- No log API for instances, so `getLogs` returns nothing.
- `vke-deployment` (Vultr Kubernetes Engine) is not implemented.
