# Polyrepo plan

Decided 2026-10-05: split into focused repositories, share code as **versioned packages**, and
use **git submodules only in a meta repo** for local development. Development continues in this
monorepo until the split is executed with `scripts/polyrepo/split.sh` (history preserved).

## Repositories (GitHub organization `orkstage`)

| Repo | Contents (from this monorepo) | Publishes | License |
|---|---|---|---|
| `orkstage` | `apps/api`, `apps/worker`, `packages/*`, `infra/docker/platform.Dockerfile`, `docs/` | `@orkstage/contracts`, `@orkstage/authorization`, `@orkstage/templates`, `@orkstage/domain` (npm, GitHub Packages); `ghcr.io/orkstage/platform` image | AGPL-3.0 + `ee/` |
| `orkstage-console` | `apps/web` | `ghcr.io/orkstage/console` image | AGPL-3.0 + `ee/` |
| `orkstage-cli` | `cli/` | `ork` binaries (signed), `@orkstage/scan` (WASM, npm), Homebrew/Scoop/winget manifests | AGPL-3.0 |
| `orkstage-modules` | `infra/tofu/modules`, `infra/docker/tofu-runner.Dockerfile` | git tags `vX.Y.Z`; `ghcr.io/orkstage/tofu-runner:<tag>` | Apache-2.0 |
| `orkstage-site` | `site/` | static site → S3 + CloudFront (orkstage.io) | MIT (code), CC BY 4.0 (content) |
| `orkstage-dev` | `infra/local/*`, new meta files | — (submodules + compose + scripts) | MIT |
| `orkstage-licensing` | new, private | license signing service | proprietary |

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

- **Contracts first.** Request/response types live in `@orkstage/contracts`; breaking changes
  need a major version and an `/api/v2` route group. The console pins a compatible range.
- **Template schema is versioned** (`apiVersion: platform/v1`). The scan engine targets a schema
  version and CI in `orkstage-cli` validates generated templates with the published
  `@orkstage/templates` package.
- **Modules are tagged**; the platform configures `TOFU_IMAGE=ghcr.io/orkstage/tofu-runner:vX.Y.Z`,
  so infrastructure code changes are explicit upgrades.
- **Compatibility matrix** (`orkstage-dev/COMPATIBILITY.md`) lists the tested combination of
  versions per release; `orkstage-dev` CI runs the end-to-end suite against it.

## Why packages, not submodules, for shared code

Submodules pin a commit, not a version: consumers drift silently, CI needs recursive checkouts
and every change needs two commits. Versioned packages give semver, changelogs and a single
upgrade PR (Renovate). Submodules are used only where pinning exact SHAs is the point: the
`orkstage-dev` meta repo that assembles a full local stack.

## Local development after the split

```bash
git clone --recurse-submodules git@github.com:orkstage/orkstage-dev.git
cd orkstage-dev
./dev.sh up            # builds images from the submodules and starts the full stack
./dev.sh link          # optional: pnpm link the local orkstage packages into the console
git submodule update --remote orkstage   # move a submodule to its latest main
```

## Deployment to AWS (control plane)

Each repo builds and publishes its artifact; a deploy repo/workflow (in `orkstage-dev` or a
private `orkstage-infra`) applies OpenTofu for the hosting environment:
ECS Fargate services for api/worker/console, RDS PostgreSQL, ElastiCache Valkey, an ALB with ACM,
Secrets Manager for `SESSION_SECRET`/`ENCRYPTION_KEY`/license, S3+CloudFront for orkstage.io.
The worker's OpenTofu runner becomes an ECS RunTask (no Docker socket in production).

## Executing the split

`scripts/polyrepo/split.sh <out-dir>` creates one local repository per target with history
(`git subtree split` per folder) and applies the package scope rename. It does **not** create
remote repositories or push; that is a separate, explicit step:

```bash
scripts/polyrepo/split.sh ../orkstage-split
# review each repo, then for each: gh repo create orkstage/<name> --public --source <dir> --push
```
