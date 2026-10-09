# Building, testing and releasing

## Build on your machine

Requirements: Rust 1.88 or later (CI uses 1.99).

```sh
cargo install --path crates/ork-cli --locked
ork --version
```

## Build in Docker

Everything (build, test, lint, WebAssembly) also runs in containers, which helps on machines
that block unsigned local binaries. Build the toolchain image once:

```sh
docker build -t orkstage/cli-builder:1.99 -f docker/builder.Dockerfile docker
```

Then run the commands from the repository root (PowerShell: use `${PWD}`; Git Bash: use
`$(pwd -W)` and set `MSYS_NO_PATHCONV=1`):

```sh
RUN="docker run --rm -v $PWD:/work -v orkstage-cargo-registry:/usr/local/cargo/registry -v orkstage-cli-target:/work/target -w /work orkstage/cli-builder:1.99"
$RUN cargo fmt --all --check
$RUN cargo clippy --workspace --all-targets -- -D warnings
$RUN cargo test --workspace
$RUN cargo bench -p orkstage-scan --bench scan          # synthetic repository of about 2,000 files
$RUN cargo build --release -p ork-cli                    # target/release/ork (Linux)
$RUN sh scripts/build-wasm.sh                            # regenerates dist/scan-wasm/
```

Snapshot tests use `insta`. After an intended change, run the tests with
`-e INSTA_UPDATE=always` and review the `.snap` diffs. Fixtures live in
`crates/orkstage-scan/tests/fixtures/<kind>/<project>/`.

`dist/scan-wasm/` is committed on purpose, and CI fails when it is out of date, so run
`scripts/build-wasm.sh` after changing the engine.

## Try the CLI against a local platform

Run the Linux binary on the Docker Compose network of the platform:

```sh
docker run --rm --network cloud-orchestrator_default \
  -e ORK_API_URL=http://api:4000 -e ORK_TOKEN=<your ork_live_ key> \
  -v orkstage-cli-target:/t:ro debian:bookworm-slim /t/release/ork whoami
```

Use `http://host.docker.internal:4000` when the API runs on the host.

## Cross compiling

| Target | Notes |
|---|---|
| `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu` | Native runners (`ubuntu-latest`, `ubuntu-24.04-arm`). |
| `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl` | Static binaries; install `musl-tools`. TLS is rustls with *ring* and the keyring backend is the pure Rust zbus, so neither OpenSSL nor libdbus is needed. |
| `x86_64-apple-darwin`, `aarch64-apple-darwin` | macOS runners. |
| `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc` | `windows-latest`. |

Release profile: `lto = "fat"`, `codegen-units = 1`, `strip = true`, `panic = "abort"`.

## Code signing

Windows binaries must be signed with Authenticode (for example Azure Trusted Signing, or
`signtool` with an EV certificate), because machines with application control refuse unsigned
executables. macOS binaries must be signed with a Developer ID (`codesign --options runtime`) and
notarized (`xcrun notarytool submit --wait`). The CI workflow has both steps; they run on tags
when the signing secrets are configured.

No release has been published yet. Until then, build from source.
