# @orkstage/cloud-render

Render adapter for OrkStage. It drives the Render REST API (`https://api.render.com/v1`)
directly: no OpenTofu, no modules and no state store. Resources are found by name in the target
workspace, so repeating an apply converges the existing resource instead of creating a second one.

## Capabilities

| Resource kind | Capability | Render resource | Notes |
| --- | --- | --- | --- |
| `web.frontend` | `render-static-site` (default) | Static site | Built from a Git repository; custom domains; pull request previews |
| `compute.container-service` | `render-web-service` (default) | Web service, image runtime | Used when `public: true`; plan from cpu and memoryMiB |
| `compute.container-service` | `render-private-service` | Private service, image runtime | Used when `public` is false; reachable only inside the workspace and region |
| `database.postgresql` | `render-postgres` (default) | Render Postgres | Plan by size; high availability on plans with a full CPU |
| `cache.redis` | `render-key-value` (default) | Render Key Value (Valkey compatible) | Plan by size; single node |

Plans used for each size:

| Size | Postgres | Key Value |
| --- | --- | --- |
| micro | `0.1c-256mb` | `256mb` |
| small | `0.5c-1g` | `1g` |
| medium | `1c-4g` | `5g` |
| large | `2c-8g` | `10g` |
| xlarge | `4c-16g` | not offered |

Services get the smallest plan that has at least the requested vCPU and memory (`0.5c-512mb`,
`1c-2g`, `2c-4g` and so on). Prices in the catalog are approximate list prices, not an invoice.

## Credential

Create an API key in the Render dashboard under Account settings, API keys. A key acts as its
user on every workspace that user belongs to, so use a dedicated user where you can.

Store the key in the secret store and point the target's `credentialRef` at it (`env://NAME` or
`aws-sm://name`). The secret can be the bare key or a JSON object:

```json
{ "apiKey": "<render api key>" }
```

## Target configuration

| Field | Required | Description |
| --- | --- | --- |
| `ownerId` | yes | Workspace id, `tea-<id>` for a team workspace or `usr-<id>` for a personal one. Find it in the workspace settings or with `GET /v1/owners`. |
| `registryCredentialId` | no | Registry credential (`rgc-<id>`) Render uses to pull private images. Create it under Workspace settings, Registry credentials. |

Allowed regions: `oregon`, `ohio`, `virginia`, `frankfurt`, `singapore`. Static sites are served
from Render's CDN and ignore the region.

Validation checks the configuration offline, then reads `GET /v1/owners/{ownerId}`. The
workspace name becomes the target identity. A rejected key, or a workspace the key's user cannot
see, fails validation with a message that never contains the key.

## Git connection for static sites

Render builds static sites from a repository it can read. Before the first deploy, connect the
Git provider (GitHub, GitLab or Bitbucket) to the workspace in the Render dashboard and grant the
Render app access to the repository named in `source.repository`. Without that access the create
call fails with a validation error from Render.

Custom domains in `domains` are added to the site; point their DNS at Render to verify them. The
`url` output switches to the first verified custom domain, otherwise it is the `onrender.com` URL.

## Environment variables and secrets

Services and static sites receive their dependencies as environment variables with the shared
names such as `<ID>_HOST`, `<ID>_PORT` and `<ID>_URL`. Credentials come from the dependency's
`secret_ref`:

* A Render Postgres or Key Value in the same workspace and region is wired with its internal
  connection string and internal host name (services only; static sites are built outside the
  private network).
* Any other provider's credentials are read through the platform's dependency secret reader and
  stored as Render environment variables, which Render keeps encrypted.

Values never appear in outputs, logs or error messages. The adapter owns the environment of the
services it manages: variables added by hand in the dashboard are replaced on the next apply.
Changes to settings or variables start one deploy so they take effect.

Postgres and Key Value publish `secret_ref` as `render-postgres://<id>` and `render-kv://<id>`.
`readSecret` returns `url` (external connection string), `internalUrl`, `username`, `password`,
`host`, `port` and, for Postgres, `database`, so a frontend on another provider can connect.

## Triggers and observability

Actions a template trigger can run:

| Capability | Action | Parameters |
| --- | --- | --- |
| web and private service | `redeploy` | `clearCache` (boolean), `commitId` (string), `imageUrl` (string) |
| web and private service | `restart`, `suspend`, `resume` | none |
| web and private service | `rollback` | `deployId` (string, required) |
| web and private service | `scale` | `numInstances` (number, required, 1 to 100) |
| static site | `redeploy`, `rollback`, `suspend`, `resume` | as above, without `imageUrl` |
| Postgres | `restart` | none |

`redeploy` and `rollback` return the Render deploy id as the action reference.

Health combines suspension, the latest deploy (live is healthy, failed is unhealthy, in progress is
degraded) and an HTTP probe of the public URL and health check path. Postgres and Key Value
health follow the status Render reports. Deploy history and logs (`GET /v1/logs`) are available
for every resource; log lines are redacted before they are returned.

## Template example

```yaml
apiVersion: platform/v1
kind: EnvironmentTemplate
metadata:
  name: render-web-stack
  version: 1.0.0
  displayName: Render web stack
  description: Static site, API and Postgres on Render.
  profile: starter
spec:
  plans: [STARTER, GROWTH]
  placements:
    - name: primary
      providers: [render]
  resources:
    - id: database
      type: database.postgresql
      size: small
      storageGiB: 10
    - id: api
      type: compute.container-service
      image: ghcr.io/acme/api:1.4.2
      cpu: 0.5
      memoryMiB: 512
      port: 8080
      public: true
      healthCheckPath: /health
      dependsOn: [database]
    - id: web
      type: web.frontend
      source:
        repository: acme/web
        branch: main
      buildCommand: npm ci && npm run build
      outputDirectory: dist
      domains: [www.acme.example]
      dependsOn: [api]
  triggers:
    - name: redeploy-api
      description: Nightly redeploy, and on demand from CI with a new image.
      resource: api
      action: redeploy
      params: { clearCache: false }
      overridable: [imageUrl, commitId]
      on:
        manual: true
        schedule: '0 3 * * *'
        webhook: true
```

The API receives `DATABASE_URL` (internal connection string), `DATABASE_HOST`, `DATABASE_PORT`,
`DATABASE_USERNAME`, `DATABASE_PASSWORD` and `DATABASE_DATABASE`; the site receives `API_URL`.

## Known limits

* Container services deploy a prebuilt image; building from source is only offered for static sites.
* A service cannot change type in place (web to private or back); delete it or rename the resource.
* Render cannot move a resource to another region, shrink Postgres storage or change the Postgres
  major version in place; the adapter logs a warning and leaves those settings as they are.
* Postgres high availability needs a plan with at least 1 CPU (size medium or larger) and version
  13 or later; on smaller plans the database runs without a standby and a warning is logged.
* Autoscaling needs a Professional workspace or higher; when Render refuses it the service runs the
  fixed `replicas` count. Render services run at least one instance; use `suspend` to stop one.
* Key Value is a single node, so `replicas` is not supported, and external access stays closed.
* Render has no resource tags, so template tags are not applied. Render has no deletion
  protection either: production resources are protected only by platform approvals.
* Custom domains removed from the template are not removed from Render.
* The adapter does not wait for deploys or database creation to finish; health reports them as
  degraded until they are live.
