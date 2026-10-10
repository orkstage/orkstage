# @orkstage/cloud-vercel

Vercel adapter for OrkStage. It deploys `web.frontend` resources as Vercel projects connected to a
Git repository, through the Vercel REST API. There is no OpenTofu and no state store: the Vercel
project itself is the state.

A typical mix: a Next.js frontend on Vercel, PostgreSQL on Supabase and files on AWS S3. The
frontend receives the connection settings and credentials of its dependencies as environment
variables.

## Capabilities

| Service kind | Capability | Default | Notes |
| --- | --- | --- | --- |
| `web.frontend` | `vercel-project` | yes | Preview deployments, custom domains, global edge network |

Pricing shows 0 per resource. Vercel bills per team seat (Pro is about 20 USD per member per
month) plus usage above the plan allowance, never per project.

## Credentials

Create an access token under Account settings, Tokens:

1. Scope: the team that will own the projects (or your personal account when the target has no
   `teamId`). A token scoped to another team fails validation with a scope message.
2. Expiration: pick one that matches your rotation policy; validation reports an expired token.

Store the token in the secret store and point the target's `credentialRef` at it
(`env://VERCEL_TOKEN` or `aws-sm://orkstage/vercel`). The secret is either the bare token or a JSON
object:

```json
{ "token": "<vercel access token>" }
```

The token never leaves the control plane process: it is sent only as the `Authorization` header to
`api.vercel.com`, and it is scrubbed from every error message.

## Target configuration

| Field | Required | Description |
| --- | --- | --- |
| `teamId` | no | Team id (`team_...`, Team settings, General). Every API call carries `?teamId=` when set. Omit it to use the personal account. |

Regions are Vercel Functions regions: `arn1`, `bom1`, `cdg1`, `cle1`, `cpt1`, `dub1`, `fra1`,
`gru1`, `hkg1`, `hnd1`, `iad1`, `icn1`, `kix1`, `lhr1`, `pdx1`, `sfo1`, `sin1`, `syd1`, `yul1`. The
placement region becomes the project's function region; put it next to the database
(`gru1` for a Supabase project in `sa-east-1`, `iad1` for `us-east-1`). Static assets are served
from the edge network everywhere.

Validation checks the team id format, the region, the token (`GET /v2/teams/{teamId}` or
`GET /v2/user`) and project access (`GET /v10/projects`). The identity shown is the team slug or
the username.

## Connect the Git repository

Vercel builds from Git, so it must be able to read the repository before the first deployment:

- GitHub: install the Vercel GitHub app (https://github.com/apps/vercel) on the organization or
  account that owns the repository and grant it access to that repository. For a team target,
  connect the app from the Vercel team (Team settings, Git).
- GitLab or Bitbucket: connect the provider in the Vercel account settings with access to the
  repository.

When Vercel cannot read the repository the deployment fails with `VERCEL_GIT_NOT_CONNECTED` and a
message naming the repository and what to install.

## What the adapter does

`ensureResource` is idempotent and keyed by the resource name (the Vercel project name):

1. Creates the project (framework, repository, build, install and output settings, root
   directory, function region, preview deployments) or patches the settings that differ.
2. Writes environment variables for the production and preview environments: template
   `environment` values and dependency connection settings (`<ID>_HOST`, `<ID>_PORT`, `<ID>_URL`,
   ...) as `encrypted`, and dependency credentials (`<ID>_PASSWORD`, `<ID>_URL` with credentials,
   ...) as `sensitive`, which Vercel never shows again. Managed variables carry a keyed fingerprint
   in their comment so unchanged values are not rewritten; managed variables removed from the
   template are deleted, variables you add by hand are left alone.
3. Attaches missing custom domains.
4. Starts a production deployment of the template branch when anything changed or the project has
   never been deployed. A repeat with nothing to change makes no writes.

Outputs: `kind`, `project_id`, `url` (first custom domain, else the `vercel.app` domain),
`dashboard_url`, `framework`, `branch`, `health_check_path`.

Health combines the latest production deployment (`READY`, building or queued is degraded, `ERROR`
is unhealthy) with an HTTP check of `url` plus `healthCheckPath`. Logs are the build and runtime
events of the latest production deployment, redacted. The deployment history maps Vercel states
to the platform's rollout states with the commit SHA as revision.

## Actions and triggers

| Action | Params | Effect |
| --- | --- | --- |
| `redeploy` | `ref` (branch or full commit SHA, default the template branch), `target` (`production` or `preview`, default `production`) | New build from the repository |
| `promote` | `deploymentId` (required) | Points production at an existing deployment without rebuilding |
| `rollback` | `deploymentId` (default: the previous production deployment) | Instant rollback |
| `purge-cache` | `tag` (default `*`, every cached response) | Marks CDN cache entries stale |

Template example: a site on Vercel reading a Supabase database, with a webhook trigger a CMS or CI
pipeline can call with its own `ref`.

```yaml
spec:
  placements:
    - name: web
      providers: [vercel]
    - name: data
      providers: [supabase]
  resources:
    - id: db
      type: database.postgresql
      placement: data
      size: micro
    - id: site
      type: web.frontend
      placement: web
      dependsOn: [db]
      source:
        repository: acme/storefront
        branch: main
        rootDirectory: apps/web
      framework: nextjs
      nodeVersion: "22"
      environment:
        NEXT_PUBLIC_SITE_NAME: Acme
      domains: [www.acme.dev]
      healthCheckPath: /api/health
  triggers:
    - name: redeploy-site
      description: Rebuild the site after content changes
      resource: site
      action: redeploy
      params:
        target: production
      overridable: [ref]
      on:
        manual: true
        webhook: true
    - name: nightly-purge
      resource: site
      action: purge-cache
      on:
        schedule: "0 3 * * *"
```

The site receives `DB_HOST`, `DB_PORT` and `DB_URL` style settings plus `DB_PASSWORD` and the other
credential fields Supabase publishes, as sensitive variables.

## Known limits

- The production branch follows the repository default branch. The REST API cannot change it, so
  set it in the project settings (Git) when the template uses another branch; deployments started
  by OrkStage always build the template branch.
- Turning preview deployments off is sent at creation and with any later settings change; the API
  does not report the current value, so toggling it alone on an existing project waits for the
  next change.
- Custom domains are attached but not removed, and their DNS records are managed outside the
  platform. A domain used by another Vercel project fails with a conflict.
- Environment variable fingerprints are keyed with the access token, so rotating the token
  rewrites the managed variables once and starts one deployment.
- Deployments are started, not awaited: health reports the build as degraded until it is ready.
- `purge-cache` with `*` relies on the project wide tag the dashboard documents; tag based purges
  need responses tagged with `Vercel-Cache-Tag`.
- GitLab and Bitbucket deployments use the project's Git link, so the repository must be
  connected when the project is created.
