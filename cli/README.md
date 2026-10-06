# OrkStage CLI (`ork`) and scan engine

`ork` turns an existing project (Terraform/OpenTofu, CloudFormation/SAM/CDK, Kubernetes/Helm,
Docker Compose, Dockerfiles, package manifests, plus Pulumi/Serverless/Bicep/ARM detection) into
an OrkStage `platform/v1` EnvironmentTemplate, pushes it, and deploys and operates instances from
your terminal or CI.

| Crate | What it is |
|---|---|
| `crates/orkstage-scan` | The scan engine (library, no I/O in its core API, compiles to wasm32). |
| `crates/orkstage-scan-wasm` | wasm-bindgen bindings, published as the npm package `@orkstage/scan` (`dist/scan-wasm/`). |
| `crates/ork-cli` | The `ork` binary. |

License: AGPL-3.0-only (part of the OrkStage open core). See [LICENSE](LICENSE).

## Install

Prebuilt binaries come from CI (`.github/workflows/ci.yml`, one per target). From source:

```sh
cargo install --path crates/ork-cli --locked     # needs Rust 1.88+
ork --version
```

Shell completions: `ork completions bash|zsh|fish|powershell|elvish > <your completion dir>`.

## Quick start

```sh
ork login --api-url https://orkstage.example.com      # prompts for an API key (ork_live_…)
cd my-project
ork init                                              # scans and writes .ork/
ork scan                                              # what was detected, with evidence
ork template validate && ork template push            # create the template / add a version
ork deploy --wait                                     # deploy .ork/config.toml [instance].slug
ork status && ork logs api
```

In CI, use an API key with the scopes you need and no prompts:

```sh
export ORK_API_URL=https://orkstage.example.com ORK_TOKEN=${{ secrets.ORK_TOKEN }}
ork -o json template push
ork deploy --instance shop-staging --wait            # non-zero exit if the deployment fails
```

## Commands

| Command | Does |
|---|---|
| `ork login [--api-url URL] [--with-token]` | Stores an API key for that API URL (from `--token`/`ORK_TOKEN`, stdin with `--with-token`, or a prompt). Verified with `GET /me` unless `--no-verify`. |
| `ork logout` / `ork whoami` | Forget the key / show user, key name, scopes and tenants. |
| `ork init [--name] [--tenant] [--environment] [--yes] [--force] [PATH]` | Scans and creates `.ork/`. Interactive unless `--yes` or stdin is not a TTY. |
| `ork scan [PATH] [--format table\|json] [--write]` | Parallel walk + scan. `PATH` may be a directory or a single file. `--write` refreshes `.ork/inventory.json` and `.ork/template.yaml`. |
| `ork template validate [-f FILE] [--plan CODE]` | `POST /templates/validate`; exit 1 when invalid. |
| `ork template push [-f FILE]` | Creates the template, or adds a DRAFT version, bumping the patch version when the local one is not newer (the file is updated). |
| `ork template diff [-f FILE] [--exit-code]` | Unified diff between the local template and the latest server version. |
| `ork import [PATH] [--tenant]` | Scans locally and `POST /imports { report }` (the code never leaves your machine); prints the import id and console URL. |
| `ork instances list [--tenant]` | Instances you can see. |
| `ork deploy [--instance SLUG] [--wait] [--timeout S]` | Deploys; `--wait` streams `/deployments/:id/events` and exits non-zero on failure. |
| `ork status [--instance SLUG]` | Instance, resources and last deployment. |
| `ork logs <resource> [--instance SLUG] [-n N]` | Recent log lines of a resource. |
| `ork destroy --instance SLUG --confirm SLUG [--wait]` | Destroys an instance. |

Global flags: `--api-url` (`ORK_API_URL`), `--token` (`ORK_TOKEN`), `-o/--output table|json`
(`ORK_OUTPUT`), `--no-color` (`NO_COLOR`), `-v/-vv/-vvv` (logs on stderr, or `ORK_LOG=debug`),
`-C DIR`.

**Precedence:** flags > environment > `.ork/config.toml` > user config.

**Exit codes:** `0` ok, `1` failure, `2` usage, `3` authentication/authorization, `4` not found.
With `-o json`, stdout carries exactly one JSON document (deterministic ordering) and errors are
printed on stderr as `{ "error": { code, message, status, correlationId, help, exitCode } }`.
API errors always show the platform's message and correlation id.

**Credentials** are stored per API URL in the OS keychain (macOS Keychain, Windows Credential
Manager, Secret Service on Linux). Where no keychain is reachable (containers, headless CI) they
go to `credentials.toml` (mode 0600) in the user config directory
(`~/.config/ork`, `%APPDATA%\OrkStage\ork\config`, `~/Library/Application Support/dev.OrkStage.ork`).
`ORK_CONFIG_DIR` moves that directory; `ORK_CREDENTIALS_STORE=file` forces the file. Keys are
never written to the project.

## `.ork/` layout

```text
.ork/
├── config.toml      # committed: api_url, tenant, template name, instance slug/environment,
│                    #            placement bindings, scan include/exclude
├── template.yaml    # committed: the platform/v1 template (generated, then yours to edit)
├── inventory.json   # local: the last ScanReport (ignored by .ork/.gitignore)
└── .gitignore
```

```toml
api_url = "https://orkstage.example.com"
tenant = "acme"

[template]
name = "shop"

[instance]
slug = "shop-staging"
environment = "staging"

# Placement slot → cloud target (name or id) and region, one line per slot of the template.
[placements]
primary = { target = "aws-staging", region = "us-east-1" }
data = { target = "azure-data", region = "westeurope" }

[scan]
include = []
exclude = ["examples/**"]
```

## How the scan works

1. **Walk** (CLI only): `.gitignore`-aware parallel walk (`ignore`), skipping `node_modules`,
   `.terraform`, `target`, `vendor`, `dist`, hidden directories and CDK `asset.*` copies; files
   above 1 MiB (configurable) and non-UTF-8 files are skipped.
2. **Detect** per source kind. Terraform is parsed with `hcl-rs`, `var.*`/`local.*` and simple
   expressions are evaluated, local modules are expanded per call (remote modules are reported as
   unmapped), and references such as `aws_db_instance.main.address` in a task definition become
   connections. CloudFormation short-form tags (`!Ref`, `!GetAtt`, `!Sub`, …) are normalised.
3. **Merge**: the same component seen in several sources becomes one resource that keeps every
   source. IaC evidence wins over Kubernetes, which wins over Compose, Dockerfiles and package
   hints (e.g. Compose `postgres` + `pg` in package.json + `aws_db_instance` → one
   `database.postgresql` on AWS).
4. **Infer** a network when services/data stores need one, and an ingress plus DNS when a public
   HTTP service runs on a cloud provider; pick placement slots (`primary` for the compute provider,
   `data`, `storage`, `messaging`, … for others) and the smallest plan whose default entitlements
   fit.
5. **Render and validate** the template (ids, references, ranges, dependency cycles — the platform's
   stages 1–2). Problems become `warnings`; the scan never fails on bad input.

The report format (ScanReport v1) is specified in `docs/specs/integration-api.md` of the
platform. Images in the template are catalog references named after each service
(`catalog://api`); the detected image is kept in the resource's `sourceImage` property.

## Using the engine from Node.js (`@orkstage/scan`)

```js
const { scanFiles, version } = require('@orkstage/scan');
const report = scanFiles([{ path: 'main.tf', content }], { templateName: 'shop' });
```

`scanFiles(files: { path: string; content: string }[], options?: { templateName?, displayName?,
templateVersion?, maxFileBytes? }): ScanReport` is synchronous and does no I/O. Types ship in
`orkstage_scan.d.ts`. The platform depends on it with `"@orkstage/scan": "file:../../cli/dist/scan-wasm"`.

## Building in Docker

Everything (build, test, lint, wasm) runs in containers, which also works on machines that
block unsigned local binaries. Build the toolchain image once:

```sh
docker build -t orkstage/cli-builder:1.99 -f docker/builder.Dockerfile docker
```

Then, from `cli/` (PowerShell: use `${PWD}`; Git Bash: `$(pwd -W)` and `MSYS_NO_PATHCONV=1`):

```sh
RUN="docker run --rm -v $PWD:/work -v orkstage-cargo-registry:/usr/local/cargo/registry -v orkstage-cli-target:/work/target -w /work orkstage/cli-builder:1.99"
$RUN cargo fmt --all --check
$RUN cargo clippy --workspace --all-targets -- -D warnings
$RUN cargo test --workspace
$RUN cargo bench -p orkstage-scan --bench scan          # ~2,000-file synthetic repo
$RUN cargo build --release -p ork-cli                    # target/release/ork (Linux)
$RUN sh scripts/build-wasm.sh                            # regenerates dist/scan-wasm/
```

Snapshot tests use `insta`; after an intended change, run the tests with `-e INSTA_UPDATE=always`
and review the `.snap` diffs. Fixtures live in `crates/orkstage-scan/tests/fixtures/<kind>/<project>/`.

To try the CLI against a platform running in Docker Compose, run the Linux binary on the compose
network: `docker run --rm --network cloud-orchestrator_default -e ORK_API_URL=http://api:4000
-e ORK_TOKEN=ork_live_… -v orkstage-cli-target:/t:ro debian:bookworm-slim /t/release/ork whoami`
(or `http://host.docker.internal:4000` when the API runs on the host).

## Cross-compiling

| Target | Notes |
|---|---|
| `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu` | Native runners (`ubuntu-latest`, `ubuntu-24.04-arm`). |
| `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl` | Static binaries; install `musl-tools`. TLS is rustls with *ring* and the keyring backend is pure-Rust zbus, so no OpenSSL/libdbus is needed. |
| `x86_64-apple-darwin`, `aarch64-apple-darwin` | macOS runners. |
| `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc` | `windows-latest`. |

Release profile: `lto = "fat"`, `codegen-units = 1`, `strip = true`, `panic = "abort"`.

**Code signing.** Windows binaries should be Authenticode-signed (e.g. Azure Trusted Signing or
`signtool` with an EV certificate) — machines with application control refuse unsigned
executables. macOS binaries must be signed with a Developer ID (`codesign --options runtime`)
and notarized (`xcrun notarytool submit --wait`). The CI workflow has the hooks; they run when
the signing secrets are configured.

## Dependencies (why these)

`clap` (derive, completions via `clap_complete`), `tokio`, `reqwest` (rustls + *ring*, no
OpenSSL), `serde`/`serde_json`, `tracing`, `indicatif`, `comfy-table`, `directories`, `keyring`
4 (keyring-core stores; file fallback), `miette` (diagnostics), `ignore` (walk),
`dialoguer` (prompts), `similar` (diffs), `toml`, `hcl-rs` (HCL), `regex`, `insta`, `assert_cmd`,
`criterion`, `wasm-bindgen`/`serde-wasm-bindgen`.

YAML: `serde_yaml` is archived and its forks `serde_yaml_ng`/`serde_norway` have had no release
since 2024, while `serde_yml` is deprecated. The engine uses **`yaml-rust2`** (actively released,
pure Rust, wasm-friendly) through its event API with a small loader of our own, because
CloudFormation needs the local tags (`!Ref`, `!GetAtt`, …) that generic loaders drop, plus
anchors/merge keys and line numbers. Templates are emitted by a small deterministic emitter that
is round-trip tested against that parser.
