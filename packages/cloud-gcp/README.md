# @orkstage/cloud-gcp

Google Cloud provider for OrkStage. Resources are created with the OpenTofu modules in
`orkstage-modules/modules/gcp`, one isolated state per resource kept in a GCS bucket you own.
Health, logs, secrets and redeploys go through the Google Cloud REST APIs.

## Target configuration

`target.config` holds only non secret identifiers:

| Field | Example | Notes |
| --- | --- | --- |
| `projectId` | `acme-prod-123` | Project id, not the project number. |
| `stateBucket` | `acme-orkstage-state` | Existing GCS bucket for OpenTofu state. The platform never creates it. |

Allowed regions are Google Cloud regions such as `us-central1`, `southamerica-east1` or `europe-west1`.

## Credentials

The secret behind `credentialRef` (`env://NAME` or `aws-sm://name`) is the service account key
JSON file exactly as Google issues it. The adapter needs `client_email` and `private_key`; it also
reads `private_key_id` and `project_id` when present. The key is used to sign a short JWT that
is exchanged for an OAuth access token (cached in memory), and it reaches OpenTofu only as the
`GOOGLE_CREDENTIALS` environment variable of one runner command.

```sh
gcloud iam service-accounts create orkstage-deployer --project acme-prod-123 --display-name "OrkStage deployer"
gcloud iam service-accounts keys create key.json --iam-account orkstage-deployer@acme-prod-123.iam.gserviceaccount.com
# Store the content of key.json in the secret store, then delete the local file.
```

Workload identity federation (no long lived key) is a planned alternative.

## State storage

Create the bucket once, in the region you deploy to most:

```sh
gcloud storage buckets create gs://acme-orkstage-state --project acme-prod-123 --location us-central1 \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://acme-orkstage-state --versioning
```

The `gcs` backend uses the state key `orkstage/<name>.tfstate` as its prefix, so the state of a
resource is the object `orkstage/<name>.tfstate/default.tfstate`. The configuration applied is
kept beside it as `orkstage/<name>.tfstate.config.json`, so destroy never depends on a newer
template.

## APIs and permissions

Enable the APIs the modules use (validation reports any that are off):

```sh
gcloud services enable compute.googleapis.com servicenetworking.googleapis.com run.googleapis.com \
  iam.googleapis.com secretmanager.googleapis.com sqladmin.googleapis.com redis.googleapis.com \
  storage.googleapis.com logging.googleapis.com --project acme-prod-123
```

Roles for the deployer service account on the project:

| Role | Why |
| --- | --- |
| `roles/browser` | Validation reads the project. |
| `roles/serviceusage.serviceUsageViewer` | Validation checks enabled APIs. |
| `roles/compute.networkAdmin` | VPC, subnet, private services range, Cloud Router and NAT. |
| `roles/servicenetworking.networksAdmin` | Private services access peering. |
| `roles/run.admin` | Cloud Run services and redeploys. |
| `roles/iam.serviceAccountAdmin`, `roles/iam.serviceAccountUser` | One runtime service account per Cloud Run service. |
| `roles/cloudsql.admin` | Cloud SQL instances, databases and users. |
| `roles/redis.admin` | Memorystore instances. |
| `roles/storage.admin` | Buckets, bucket IAM and the state bucket. |
| `roles/secretmanager.admin` | Credential secrets and their IAM bindings; `readSecret`. |
| `roles/logging.viewer` | Service logs in the console. |

## Capabilities

| Kind | Capability | Module | Notes |
| --- | --- | --- | --- |
| `network` | `vpc` (default) | `network` | Custom mode VPC, one regional subnet with private Google access, a private services access range for Cloud SQL and Memorystore, Cloud NAT when `natGateway` is set. |
| `compute.container-service` | `cloud-run` (default) | `container-service` | Cloud Run v2 service with its own service account. Direct VPC egress into the subnet when a network is in the slot (all traffic through NAT when the network has one). `replicas` or the autoscaling range sets the instance bounds. Public services accept unauthenticated calls; others accept internal traffic only. Database and cache credentials are mounted from Secret Manager as `<ID>_CREDENTIALS`. Supports the `redeploy` action. |
| `database.postgresql` | `cloud-sql-postgres` (default) | `postgres` | Enterprise edition; private IP only when a network is in the slot. Regional availability for `zone-redundant` HA, backups with point in time recovery, deletion protection in production, TLS required. The app password lives in state and in a Secret Manager secret (`secret_ref`). |
| `cache.redis` | `memorystore-redis` (default) | `redis` | Basic tier without replicas, Standard tier with one replica, read replicas from two. AUTH on; the AUTH string is stored in Secret Manager (`secret_ref`). |
| `object-storage` | `gcs` (default) | `object-storage` | Uniform access, public access prevention unless `publicAccess`, versioning, class change after 30 days for `infrequent` (Nearline) and `archive`, expiry from `retentionDays`. Cloud Run services that depend on the bucket get read and write access. |
| `ingress` | `cloud-run-ingress` (default) | none | Uses the HTTPS URL Cloud Run gives every service; routed services become public. |

`readSecret` returns the fields of the secret: `username`, `password`, `host`, `port`,
`database`, `url` for Postgres and `password`, `host`, `port`, `url` for Redis.

## Known limits

- Cloud Run CPU is rounded up to 1, 2, 4, 6 or 8 vCPU; fractional CPU would force one request per instance.
- Cloud Run scales on request concurrency; `targetCpuPercent` is not used.
- There is no shared HTTPS load balancer with path routing yet; each service keeps its own run.app URL.
- A Postgres instance without a network gets a public IP with no authorized networks, reachable only through Cloud SQL connectors.
- Memorystore runs without in transit encryption; traffic stays inside the VPC.
- The private services peering is abandoned on destroy and removed with the network.
- Credentials of dependencies outside Google Cloud are not mounted into Cloud Run.
