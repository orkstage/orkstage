# Build/test image for the OrkStage CLI workspace: the official Rust image plus rustfmt,
# clippy, the wasm32 target and wasm-bindgen-cli pinned to the crate's wasm-bindgen version.
#
#   docker build -t orkstage/cli-builder:1.99 -f docker/builder.Dockerfile docker
FROM rust:1.99-bookworm

ARG WASM_BINDGEN_VERSION=0.2.129

RUN rustup component add rustfmt clippy \
 && rustup target add wasm32-unknown-unknown \
 && cargo install wasm-bindgen-cli --version "${WASM_BINDGEN_VERSION}" --locked \
 && rm -rf /usr/local/cargo/registry/cache /usr/local/cargo/registry/src

WORKDIR /work
