# @orkstage/cloud-supabase

Supabase adapter for OrkStage. It talks to the Supabase Management API
(`https://api.supabase.com/v1`) and to each project's Storage API. There is no OpenTofu, no
module and no state store: Supabase keeps the state, and the adapter finds its resources again by
name.

Typical use is mixing providers for cost: a Vercel frontend, PostgreSQL on Supabase and files on
AWS S3, all in one template.

## Capabilities

| Service kind | Capability | What it creates | Default |
| --- | --- | --- | --- |
| `database.postgresql` | `supabase-postgres` | One Supabase project per resource | yes |
| `object-storage` | `supabase-storage` | A Storage bucket inside a `supabase-postgres` project | yes |

### supabase-postgres

Creates a project named after the resource (`req.name`) in the target's organization and region,
then waits (bounded, cancellable) until it reports `ACTIVE_HEALTHY`. The template `size` becomes
the compute size (`micro`, `small`, `medium`, `large`, `xlarge`); on a free plan organization the
size is left to Supabase (Nano).

Outputs: `kind`, `project_ref`, `host` (`db.<ref>.supabase.co`), `port` (5432), `database`
(`postgres`), `username` (`postgres`), `pooler_host`, `pooler_port`, `pooler_username`, `region`,
`api_url`, `dashboard_url` and `secret_ref` (`supabase://<ref>/database`).

Actions (template triggers or operators):

| Action | Params | API call |
| --- | --- | --- |
| `restart` | none | `POST /v1/projects/{ref}/restart` |
| `pause` | none | `POST /v1/projects/{ref}/pause` |
| `restore` | none | `POST /v1/projects/{ref}/restore` (resumes a paused project) |
| `backup` | `name` (optional, at most 20 characters) | `POST /v1/projects/{ref}/database/backups/restore-point` |

### supabase-storage

Creates a bucket named after the resource inside the project of the `supabase-postgres` resource
it depends on. Without that dependency the deployment fails with a validation error asking for
`dependsOn`. `publicAccess` sets the bucket's public flag and is converged on every apply.

Outputs: `kind`, `bucket`, `endpoint` (S3 compatible, `https://<ref>.supabase.co/storage/v1/s3`),
`region`, `project_ref`, `api_url`, `public`, `public_url` (public buckets only),
`deletion_protected` and `secret_ref` (`supabase://<ref>/storage`).

## Setup

### Token

Create a personal access token in the Supabase dashboard under Account, Access Tokens
(`https://supabase.com/dashboard/account/tokens`). The token acts as its owner, so use an account
that is a member of the target organization. An OAuth access token works too; it needs the
scopes `organizations:read`, `projects:read`, `projects:write`, `secrets:read`, `database:read`,
`database:write` (restore points) and `analytics:read` (logs).

Store it where the target's `credentialRef` points (env://NAME or aws-sm://name), either as the bare
token or as JSON:

```json
{ "token": "<personal access token>" }
```

### Organization

The target config needs the organization slug. It is the id in the dashboard URL
(`https://supabase.com/dashboard/org/<slug>`), or the `slug` field of `GET /v1/organizations`:

```sh
curl -s -H "Authorization: Bearer $SUPABASE_TOKEN" https://api.supabase.com/v1/organizations
```

Cloud target example:

```json
{
  "provider": "supabase",
  "name": "Acme data",
  "config": { "organizationId": "acme-slug" },
  "credentialRef": "env://SUPABASE_TOKEN",
  "allowedRegions": ["sa-east-1", "us-east-1"],
  "defaultRegion": "sa-east-1"
}
```

Regions are Supabase region codes: `us-east-1`, `us-east-2`, `us-west-1`, `us-west-2`,
`ca-central-1`, `sa-east-1`, `eu-west-1`, `eu-west-2`, `eu-west-3`, `eu-north-1`, `eu-central-1`,
`eu-central-2`, `ap-east-1`, `ap-south-1`, `ap-southeast-1`, `ap-southeast-2`, `ap-northeast-1`,
`ap-northeast-2`.

Validation lists the organizations the token can see, checks that the configured slug is one of
them (the identity shown is the organization name), reports the plan and checks the region.

## Template example

A Next.js site on Vercel, PostgreSQL on Supabase and uploads on AWS S3. Bind `web` to a Vercel
target, `data` to a Supabase target and `files` to an AWS target.

```yaml
apiVersion: platform/v1
kind: EnvironmentTemplate
metadata:
  name: vercel-supabase-s3
  version: 1.0.0
  displayName: Vercel, Supabase and S3
  profile: starter
spec:
  plans: [STARTER, GROWTH]
  placements:
    - name: web
      providers: [vercel]
    - name: data
      providers: [supabase]
    - name: files
      providers: [aws]
  resources:
    - id: db
      type: database.postgresql
      placement: data
      implementation: supabase-postgres
      size: small
    - id: uploads
      type: object-storage
      placement: files
      implementation: s3
    - id: site
      type: web.frontend
      placement: web
      dependsOn: [db, uploads]
      source:
        repository: acme/site
        branch: main
      framework: nextjs
  triggers:
    - name: restart-db
      resource: db
      action: restart
    - name: nightly-restore-point
      resource: db
      action: backup
      on: { manual: true, schedule: "0 3 * * *" }
```

To keep files on Supabase instead, place a `supabase-storage` bucket on the `data` slot with
`dependsOn: [db]`.

## How secrets flow

* The database password is never stored. The platform runtime derives it from its encryption key
  (HMAC of `supabase:db:<target id>:<project name>`); the adapter turns that into a 32 character
  alphanumeric password, sends it once when creating the project, and derives it again whenever
  it is needed.
* Outputs carry only `secret_ref`. A resource on another provider (the Vercel site above) asks the
  platform for the dependency secret, and the platform calls `readSecret` here:
  * `supabase://<ref>/database` returns `url` (direct connection, `sslmode=require`), `poolerUrl`
    (Supavisor), `username`, `password`, `host`, `port` and `database`.
  * `supabase://<ref>/storage` returns `url` (project API URL), `serviceRoleKey` and `anonKey`,
    read from the Management API each time.
* Values never appear in outputs, logs or error messages; errors from Supabase are redacted.

## Health, logs and deletion

* Health: the project status first (`ACTIVE_HEALTHY` continues, `COMING_UP` and other transitions
  are degraded, paused or failed projects are unhealthy), then `GET /v1/projects/{ref}/health`
  for `db,rest,auth,storage` (database) or `storage` plus the bucket itself (storage). The
  database service is critical; other services down only degrade.
* Logs: the last hour of the unified logs stream (`postgres_logs` or `storage_logs`) through
  `GET /v1/projects/{ref}/analytics/endpoints/logs`.
* Deleting a database deletes the whole project, including its buckets. The platform's destroy
  protection is what guards production.
* Deleting a bucket empties it first unless it was created for a production environment
  (`deletion_protected`); a protected bucket that still has objects is not deleted.

## Limits

* One Supabase project per database; Supabase picks the Postgres major version.
* Free plan: Nano compute whatever the template asks, at most two active projects, 500 MB
  database, 1 GB storage, projects pause after a week without activity (run `restore`).
* Compute size applies at creation only; resize in the dashboard (it restarts the database).
* No high availability through the API; read replicas are a paid addon outside this adapter.
* The direct host is IPv6 only without the IPv4 addon. IPv4 clients such as serverless
  functions should use `poolerUrl`.
* Storage has no versioning, lifecycle rules or tiers. The Management API cannot create S3 access
  keys, so none are returned; create them in the dashboard if a client needs the S3 protocol.
* Restore points depend on the organization plan; the `backup` action fails cleanly where they
  are not offered.
* Pricing in the catalog is the compute addon list price (Micro 10, Small 15, Medium 60,
  Large 110, XL 210 USD a month, disk 0.125 USD per GB after 8 GB); the plan fee is separate.
