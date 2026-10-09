# Polyrepo plan

Decided on October 5, 2026: split into focused repositories, share code as **versioned packages**,
and use **git submodules only in a meta repository** for local development. Development
continues in this monorepo until the split is executed with `scripts/polyrepo/split.sh`, which
preserves history.

## Repositories (GitHub organization `orkstage`)

| Repository | Contents (from this monorepo) | Publishes | License |
|---|---|---|---|
| `orkstage` | `apps/api`, `apps/worker`, `packages/*`, `infra/docker/platform.Dockerfile`, `docs/` | `@orkstage/contracts`, `@orkstage/authorization`, `@orkstage/templates`, `@orkstage/domain` (npm, GitHub Packages); the `ghcr.io/orkstage/platform` image | AGPL-3.0 + `ee/` |
| `orkstage-console` | `apps/web` | the `ghcr.io/orkstage/console` image | AGPL-3.0 + `ee/` |
| `orkstage-cli` | `cli/` | signed `ork` binaries, `@orkstage/scan` (WebAssembly, npm), Homebrew, Scoop and winget manifests | AGPL-3.0 |
| `orkstage-modules` | `infra/tofu/modules`, `infra/docker/tofu-runner.Dockerfile` | git tags `vX.Y.Z`; `ghcr.io/orkstage/tofu-runner:<tag>` | Apache-2.0 |
| `orkstage-site` | `site/` | static site on S3 and CloudFront (orkstage.io) | MIT (code), CC BY 4.0 (content) |
| `orkstage-dev` | `infra/local/*` plus generated meta files | nothing (submodules, compose, scripts) | MIT |
| `.github` | `scripts/polyrepo/org-dotgithub/` | organization profile and default community health files | |
| `orkstage-licensing` | new, private | license signing service | proprietary |

Repository metadata (descriptions, topics, visibility) lives in
[`scripts/polyrepo/repos.json`](../scripts/polyrepo/repos.json).

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

## Executing the split

`scripts/polyrepo/split.sh <out-dir>` creates one local repository per target. Folder
repositories keep their history (`git subtree split`), the core keeps the full history without
the private material, the package scope is renamed from `@co` to `@orkstage`, and the
organization `.github` repository is created from `scripts/polyrepo/org-dotgithub/`. The script
never creates remote repositories and never pushes.

Publishing is a separate, explicit step with `scripts/polyrepo/publish.sh`:

```bash
scripts/polyrepo/split.sh ../orkstage-split
scripts/polyrepo/publish.sh --dry-run ../orkstage-split   # prints every action, no network
scripts/polyrepo/publish.sh ../orkstage-split             # creates missing repos as private and pushes
```

`publish.sh` reads `repos.json`, creates missing repositories as **private**, pushes `main` and
tags, and sets the description, homepage, topics and features. It never changes the visibility
of an existing repository. Making a repository public is a manual decision. At the end it prints
the steps that cannot be scripted, such as uploading the social preview images from
`.github/assets/social-preview.png` in each repository.

## Known gaps before the split is usable on its own

- The core keeps the monorepo `pnpm-lock.yaml`. After the scope rename and the removal of the
  console and CLI it must be regenerated (`pnpm install --lockfile-only`) before
  `pnpm install --frozen-lockfile` passes in CI.
- `infra/local/docker-compose.yml` builds the platform and runner images from the monorepo
  layout (`context: ../..`). In the core repository the `platform` profile needs the console and
  the modules, and in `orkstage-dev` the build contexts point outside the repository. Both need
  published images (`ghcr.io/orkstage/platform`, `console`, `tofu-runner`) or new build contexts.
- The console installs `@orkstage/*` packages from GitHub Packages, so its CI can only build once
  those packages are published.
