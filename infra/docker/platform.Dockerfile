# syntax=docker/dockerfile:1.7
# One image for the control plane (api, worker, migrate); each Compose service picks
# its command. Built from the repository root: docker build -f infra/docker/platform.Dockerfile .

# Pinned to a Node release with the October 2026 security fixes (Brotli, TLS hostname checks,
# dns.resolve, OpenSSL 3.5.9); `apk upgrade` refreshes ca-certificates and the other OS packages.
FROM mirror.gcr.io/library/node:24.22.1-alpine AS base
# openssl: Prisma schema engine (migrations). docker-cli: the worker launches OpenTofu runner containers.
RUN apk upgrade --no-cache  && apk add --no-cache openssl docker-cli \
 && npm install -g pnpm@12.5.1 \
 && addgroup -S -g 10001 orkstage && adduser -S -u 10001 -G orkstage orkstage
WORKDIR /repo

FROM base AS build
# Inputs only needed at build time. The real DATABASE_URL is provided at runtime.
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL} \
    DATABASE_URL=postgresql://build:build@localhost:5432/build \
    NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm -r --workspace-concurrency=1 run build
# TypeScript 7 is a native compiler binary that only the build needs; the runtime runs dist/.
RUN rm -rf node_modules/.pnpm/@typescript+typescript-*

FROM base AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# npm, corepack and pnpm only install and build in the earlier stages; nothing runs them at runtime
# (migrations call Prisma directly), and each bundles its own dependencies (and their advisories).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/pnpm  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/pn /usr/local/bin/pnx
COPY --from=build --chown=orkstage:orkstage /repo /repo
# With TOFU_RUNNER=docker the worker needs the Docker socket (root-owned) to start runner containers;
# api/web/migrate run as the unprivileged user (set per service in Compose). User 10001 is fixed so
# ECS and Kubernetes runners can run as the worker's user (ADR 0016).
EXPOSE 3000 4000
CMD ["node", "--version"]
