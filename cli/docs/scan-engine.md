# The scan engine

`orkstage-scan` turns project files into a ScanReport and a `platform/v1` template. It is a Rust
library with no I/O in its core API, so the same code runs in the `ork` binary and, compiled to
WebAssembly, inside the OrkStage API (file uploads on the import page).

Supported sources: Terraform and OpenTofu, CloudFormation, SAM, CDK, Kubernetes manifests, Helm,
Docker Compose, Dockerfiles and package manifests. Pulumi, Serverless, Bicep and ARM are
detected and reported.

## How a scan works

1. **Walk** (CLI only). A parallel walk that respects `.gitignore` (the `ignore` crate) and skips
   `node_modules`, `.terraform`, `target`, `vendor`, `dist`, hidden directories and CDK
   `asset.*` copies. Files above 1 MiB (configurable) and files that are not UTF-8 are skipped.
2. **Detect** per source kind. Terraform is parsed with `hcl-rs`: `var.*`, `local.*` and simple
   expressions are evaluated, local modules are expanded per call (remote modules are reported
   as unmapped), and references such as `aws_db_instance.main.address` in a task definition
   become connections. CloudFormation short form tags (`!Ref`, `!GetAtt`, `!Sub`) are
   normalized.
3. **Merge.** The same component seen in several sources becomes one resource that keeps every
   source. IaC evidence wins over Kubernetes, which wins over Compose, Dockerfiles and package
   hints. For example, a Compose `postgres` service, `pg` in `package.json` and an
   `aws_db_instance` become one `database.postgresql` on AWS.
4. **Infer.** A network is added when services or data stores need one, and an ingress with DNS
   when a public HTTP service runs on a cloud provider. Placement slots are chosen (`primary` for
   the compute provider; `data`, `storage` or `messaging` for the others), along with the
   smallest plan whose default entitlements fit.
5. **Render and validate** the template: ids, references, ranges and dependency cycles (stages
   1 and 2 of the platform's validation). Problems become `warnings`; a scan never fails on bad
   input.

The report format (ScanReport v1) is specified in
[`docs/specs/integration-api.md`](https://github.com/orkstage/orkstage/blob/main/docs/specs/integration-api.md)
in the core repository. Images in the template are catalog references named after each service
(`catalog://api`); the detected image is kept in the resource's `sourceImage` property.

## Using the engine from Node.js (`@orkstage/scan`)

```js
const { scanFiles, version } = require('@orkstage/scan');
const report = scanFiles([{ path: 'main.tf', content }], { templateName: 'shop' });
```

`scanFiles(files: { path: string; content: string }[], options?: { templateName?, displayName?,
templateVersion?, maxFileBytes? }): ScanReport` is synchronous and does no I/O. Types ship in
`orkstage_scan.d.ts`. The package is built into `dist/scan-wasm/` (see
[building.md](building.md)). In the development monorepo the platform depends on it with
`"@orkstage/scan": "file:../../cli/dist/scan-wasm"`; after the split it consumes the published
package.

## Dependencies and why

`clap` (derive, completions through `clap_complete`), `tokio`, `reqwest` (rustls with *ring*, no
OpenSSL), `serde` and `serde_json`, `tracing`, `indicatif`, `comfy-table`, `directories`,
`keyring` 4 (keyring core stores with a file fallback), `miette` (diagnostics), `ignore` (walk),
`dialoguer` (prompts), `similar` (diffs), `toml`, `hcl-rs` (HCL), `regex`, `insta`,
`assert_cmd`, `criterion`, `wasm-bindgen` and `serde-wasm-bindgen`.

YAML: `serde_yaml` is archived, its forks `serde_yaml_ng` and `serde_norway` have had no release
since 2024, and `serde_yml` is deprecated. The engine uses **`yaml-rust2`** (actively released,
pure Rust, works in WebAssembly) through its event API with a small loader of its own, because
CloudFormation needs the local tags (`!Ref`, `!GetAtt`) that generic loaders drop, plus anchors,
merge keys and line numbers. Templates are written by a small deterministic emitter that has
round trip tests against that parser.
