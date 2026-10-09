# Contributing to the OrkStage CLI

The organization guide ([CONTRIBUTING.md in orkstage/.github](https://github.com/orkstage/.github/blob/main/CONTRIBUTING.md))
covers the workflow, the CLA and the code of conduct. This file covers what is specific to the
CLI and the scan engine.

## Checks CI runs

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
sh scripts/build-wasm.sh && git diff --exit-code -- dist/scan-wasm
```

Tests run on Linux, macOS and Windows. Every command above also runs in the Docker toolchain
image; see [docs/building.md](../docs/building.md).

## Snapshot tests

Scan results are covered by `insta` snapshots. After an intended change, update them with
`INSTA_UPDATE=always cargo test --workspace` and review every `.snap` diff in the pull request.
In CI, a missing or changed snapshot fails the build.

## Adding or changing a detector

1. Add a small, realistic project under `crates/orkstage-scan/tests/fixtures/<kind>/<project>/`.
2. Keep the mapping rules in the engine, not in the CLI: the API uses the same engine through
   WebAssembly.
3. Report what cannot be mapped in `unmapped` with a reason, instead of guessing.
4. Rebuild `dist/scan-wasm/` with `scripts/build-wasm.sh` and commit it.

## Changes to the API contract

The CLI follows the contract in
[`docs/specs/integration-api.md`](https://github.com/orkstage/orkstage/blob/main/docs/specs/integration-api.md)
of the core repository. Propose contract changes there first.
