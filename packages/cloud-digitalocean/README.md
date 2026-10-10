# @orkstage/cloud-digitalocean

DigitalOcean provider for OrkStage. Resources are created with OpenTofu modules from
`orkstage-modules/modules/digitalocean`, one isolated state per resource, kept in a Spaces bucket
of your own team. Health, logs, deployments and actions use the DigitalOcean REST API.

## Cloud target

One target is one DigitalOcean team. Regions are datacenter slugs (`nyc3`, `sfo3`, `ams3`,
`fra1`, `sgp1`, `lon1`, `tor1`, `blr1`, `syd1`, `atl1`, `nyc1`).

Target config (non secret):

| Field | Example | Meaning |
|---|---|---|
| `stateBucket` | `acme-orkstage-tfstate` | Existing Spaces bucket for OpenTofu state |
| `stateRegion` | `nyc3` | Spaces region of that bucket |

Credential secret behind `credentialRef` (`env://NAME` or `aws-sm://name`), a JSON object:

```json
{ "token": "dop_v1_...", "spacesAccessKeyId": "DO00...", "spacesSecretAccessKey": "..." }
```

The values reach OpenTofu only as runner environment variables (`DIGITALOCEAN_TOKEN`,
`SPACES_ACCESS_KEY_ID`, `SPACES_SECRET_ACCESS_KEY`, and `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` for the state backend).

## State storage

Create the bucket once, before validating the target. OrkStage never creates it.

```sh
# Spaces key with access to every bucket (state and the buckets OrkStage manages)
doctl spaces keys create orkstage --grants 'bucket=;permission=fullaccess'

# Bucket for state, versioned so an older state can be restored
export AWS_ACCESS_KEY_ID=<access key> AWS_SECRET_ACCESS_KEY=<secret key>
aws s3api create-bucket --bucket acme-orkstage-tfstate --endpoint-url https://nyc3.digitaloceanspaces.com --region us-east-1
aws s3api put-bucket-versioning --bucket acme-orkstage-tfstate --versioning-configuration Status=Enabled --endpoint-url https://nyc3.digitaloceanspaces.com --region us-east-1
```

The backend signs as `us-east-1` against `https://<stateRegion>.digitaloceanspaces.com`, as
DigitalOcean documents, with `use_lockfile` state locking.

## Token permissions

A full access token works. A custom scoped token needs create, read, update and delete on
`vpc`, `app` and `database`, plus `account:read` and `tag:create`. Validation probes the VPC,
App Platform and database scopes and fails when a scope needed by the resources about to be
deployed is missing.

## Capabilities

| Kind | Capability | DigitalOcean product | Notes |
|---|---|---|---|
| `network` | `vpc` (default) | VPC | DigitalOcean picks a free IP range |
| `compute.container-service` | `app-platform` (default) | App Platform | One app, one service component from an image. Size from cpu and memory, CPU autoscaling on dedicated sizes, health check, encrypted database URLs |
| `database.postgresql` | `managed-postgres` (default) | Managed PostgreSQL | Joins the VPC, trusted sources limited to the VPC range unless `publicAccess`; HA adds a standby node |
| `cache.redis` | `managed-valkey` (default) | Managed Valkey | Redis compatible, TLS, up to two standby nodes, VPC only |
| `object-storage` | `spaces` (default) | Spaces | Versioning, expiration lifecycle, private unless `publicAccess` |
| `ingress` | `app-platform-ingress` (default) | App Platform routing | No infrastructure; each service applies its route path prefix to its own app |

Database credentials are never module outputs. Postgres and Valkey publish
`secret_ref = do-db://<cluster id>`; the adapter reads the connection details from the
DigitalOcean API (`readSecret`) when a resource on another provider needs them. App Platform
services receive `<ID>_URL` for each DigitalOcean database dependency as a `SECRET` variable,
read by the module from the database cluster data source.

Actions on `app-platform`: `redeploy` (new deployment, `forceBuild` defaults to true) and
`restart` (rolling restart). Deployment history and run logs come from the App Platform API.

## Known limits

- App Platform joins a VPC only from one datacenter per region: `ams3`, `atl1`, `blr1`, `fra1`,
  `lon1`, `nyc1`, `sfo3`, `sgp1`, `syd1`, `tor1`. In other regions (for example `nyc3`) a service
  cannot reach a private database, and deploying such a pair fails validation; use one of those
  regions or give the database public access.
- Spaces is not offered in `nyc1`; place buckets in another region.
- App Platform pulls images from DigitalOcean Container Registry, Docker Hub and GHCR only;
  private Docker Hub or GHCR images need registry credentials, which are not wired yet.
- Credentials of dependencies on other providers reach the service as `<ID>_CREDENTIALS_REF`
  references, not values.
- Services do not receive Spaces keys for their buckets, only the bucket name and endpoint.
- Managed database backups are daily with 7 days of recovery; retention is not configurable.
- From 15 October 2026 (new accounts) and 30 November 2026 (all accounts) new Standard Edition
  PostgreSQL clusters cannot add standby nodes or use plans above 4 GiB. Use
  `overrides.digitalocean.size` with an Advanced Edition slug when you need them.
- There is no load balancer capability yet; `ingress` is App Platform routing only.
- Production resources keep `force_destroy` off on buckets; DigitalOcean has no deletion
  protection flag for database clusters.
