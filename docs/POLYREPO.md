# Polyrepo layout

Decided on October 5, 2026: focused repositories, code shared as **versioned packages**, and
**git submodules only in a meta repository** for local development. The monorepo was split on
October 9, 2026 with its history preserved. The repositories below are now the source of truth,
and day to day development happens in the [`orkstage-dev`](https://github.com/orkstage/orkstage-dev)
workspace.

## Repositories (GitHub organization `orkstage`)

| Repository | Contents (from this monorepo) | Publishes | License |
|---|---|---|---|
| `orkstage` | `apps/api`, `apps/worker`, `packages/*`, `infra/docker/platform.Dockerfile`, `docs/` | `@orkstage/contracts`, `@orkstage/authorization`, `@orkstage/templates`, `@orkstage/domain` (npm, GitHub Packages); the `ghcr.io/orkstage/platform` image | AGPL-3.0 + `ee/` |
| `orkstage-console` | `apps/web` | the `ghcr.io/orkstage/console` image | AGPL-3.0 |
| `orkstage-cli` | `cli/` | signed `ork` binaries, `@orkstage/scan` (WebAssembly, npm), Homebrew, Scoop and winget manifests | AGPL-3.0 |
| `orkstage-modules` | `infra/tofu/modules`, `infra/docker/tofu-runner.Dockerfile` | git tags `vX.Y.Z`; `ghcr.io/orkstage/tofu-runner:<tag>` | Apache-2.0 |
| `orkstage-site` | `site/` | static site on S3 and CloudFront (orkstage.io) | MIT (code), CC BY 4.0 (content) |
| `orkstage-dev` | `infra/local/*` plus generated meta files | nothing (submodules, compose, scripts) | MIT |
| `.github` | organization profile and default community health files | | |
| `orkstage-licensing` | new, private | license signing service | proprietary |

Every repository is private for now. The open source ones become public at launch;
`orkstage-licensing` stays private.

## Dependency graph

```text
orkstage-console ──npm──▶ @orkstage/contracts, /authorization, /templates, /domain  (from orkstage)
orkstage (api)   ──npm──▶ @orkstage/scan (from orkstage-cli, WASM)
orkstage (worker)──image─▶ ghcr.io/orkstage/tofu-runner:<modules tag> (from orkstage-modules)
orkstage-cli     ──HTTP──▶ OrkStage API (contract: docs/specs/integration-api.md, OpenAPI)
orkstage-site    ──file──▶ OpenAPI JSON exported by orkstage CI (release asset)
orkstage-dev     ──git submodules──▶ all public repos (pinned SHAs)
```

Compatibility rules:

- **Contracts first.** Request and response types live in `@orkstage/contracts`. Breaking
  changes need a major version and an `/api/v2` route group. The console pins a compatible range.
- **The template schema is versioned** (`apiVersion: platform/v1`). The scan engine targets a
  schema version, and CI in `orkstage-cli` validates generated templates with the published
  `@orkstage/templates` package.
- **Modules are tagged.** The platform sets `TOFU_IMAGE=ghcr.io/orkstage/tofu-runner:vX.Y.Z`, so
  changes to infrastructure code are explicit upgrades.
- **Compatibility matrix.** `orkstage-dev/COMPATIBILITY.md` lists the tested combination of
  versions for each release, and `orkstage-dev` CI runs the end to end suite against it.

## Why packages, not submodules, for shared code

Submodules pin a commit, not a version: consumers drift silently, CI needs recursive checkouts,
and every change needs two commits. Versioned packages give semver, changelogs and a single
upgrade pull request (Renovate or Dependabot). Submodules are used only where pinning exact SHAs
is the point: the `orkstage-dev` meta repository that assembles a full local stack.

## Local development after the split

```bash
git clone --recurse-submodules git@github.com:orkstage/orkstage-dev.git
cd orkstage-dev
./dev.sh up            # planned: builds images from the submodules and starts the full stack
./dev.sh link          # planned: pnpm link the local orkstage packages into the console
git submodule update --remote orkstage   # move a submodule to its latest main
```

`dev.sh` does not exist yet. Until the platform, console and runner images are published, the
compose file in `orkstage-dev` starts the supporting services (Postgres, Redis, Mailpit,
MiniStack) and the applications run from their submodules.

## Deployment to AWS (control plane)

Each repository builds and publishes its artifact. A deploy workflow (in `orkstage-dev` or in a
private `orkstage-infra`) applies OpenTofu for the hosting environment: ECS Fargate services for
the API, worker and console, RDS PostgreSQL, ElastiCache Valkey, an ALB with ACM, Secrets Manager
for `SESSION_SECRET`, `ENCRYPTION_KEY` and the license, and S3 with CloudFront for orkstage.io.
The worker's OpenTofu runner becomes an ECS RunTask (no Docker socket in production).

## How the split was done

The monorepo was split with a script that kept the history of every folder (`git subtree
split`), removed private material from the core history, renamed the package scope from `@co` to
`@orkstage` and created the repositories as private. That tooling lived in the monorepo and is
not part of these repositories. Changes now go to each repository through pull requests.

## Known gaps

- The shared `@orkstage/*` packages, the scan engine and the container images
  (`ghcr.io/orkstage/platform`, `console`, `tofu-runner`) are not published yet. Until they are,
  the console builds against the core checkout in `orkstage-dev` (pnpm overrides), the console
  CI skips its build, and the full stack is built locally from the submodules.
