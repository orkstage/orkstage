# syntax=docker/dockerfile:1.7
# One image for the control plane (api, worker, migrate); each Compose service picks
# its command. Built from the repository root: docker build -f infra/docker/platform.Dockerfile .

FROM mirror.gcr.io/library/node:24-alpine AS base
# openssl: Prisma schema engine (migrations). docker-cli: the worker launches OpenTofu runner containers.
RUN apk add --no-cache openssl docker-cli \
 && npm install -g pnpm@12.5.1 \
 && addgroup -S orkstage && adduser -S orkstage -G orkstage
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

FROM base AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=orkstage:orkstage /repo /repo
# The worker needs the Docker socket (root-owned) to start runner containers; api/web/migrate
# run as the unprivileged user (set per service in Compose).
EXPOSE 3000 4000
CMD ["node", "--version"]
