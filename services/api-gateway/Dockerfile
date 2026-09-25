# syntax=docker/dockerfile:1.7
# =============================================================================
# api-gateway
#
# The single entry point for external traffic. Authenticates, resolves the
# tenant, rate limits and routes. Holds no business logic and no database —
# the only service in this platform without one (CLAUDE.md service table) —
# so unlike every other Dockerfile here, this one has no Prisma client to
# generate and no Prisma engine cache to mount. `services/api-gateway/package.json`
# confirms it: `"build": "tsc -p tsconfig.json"`, no `db:generate`, no
# `prisma` dependency anywhere in its tree.
#
# Built from the repository root, because a pnpm workspace resolves through the
# root lockfile and the linked @rasta/* packages. Building from the service
# directory would produce an image that cannot see its own dependencies.
#
# The stage reasoning otherwise matches the eleven images that precede it, and
# each comment records a failure that actually happened when those were first
# built — kept so this service does not rediscover them.
#
# This file and the CI image matrix entry are one commit on purpose. A Dockerfile
# without a matrix row is an image built by nobody and scanned by nobody, which
# is how asset, fleet and document each went unscanned for a release
# (PROJECT_MEMORY § 22). `pnpm run ci:image-matrix` fails the build if the two
# ever drift apart again.
# =============================================================================

# ---- deps -------------------------------------------------------------------
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS deps

# pnpm is installed directly rather than through corepack. Corepack downloads
# the tarball at build time and crashes intermittently doing so
# (`AssertionError: assert(!this.paused)`), which turns an image build into a
# coin flip. A pinned npm install is deterministic and needs no TTY.
RUN npm install -g pnpm@11.22.0

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"

# The whole workspace is copied before installing, not just this service's
# manifest. `--frozen-lockfile` validates the lockfile against every project the
# workspace globs match, so a partial copy reads as a lockfile mismatch and
# fails.
#
# The layer cache is therefore invalidated by any source change, so the pnpm
# store is mounted as a BuildKit cache instead: the install stays fast because
# packages are already in the store, even when the layer must re-run.
COPY . .

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

# Compiles this service and its workspace dependencies in dependency order.
# No Prisma client generation step: api-gateway owns no database.
RUN pnpm --filter @rasta/api-gateway... build

# `pnpm deploy` rather than `prune`, and the difference matters.
#
# pnpm's isolated node_modules layout means a workspace package resolves its
# peer dependencies through the *consumer*, not through its own directory. So a
# naively copied packages/nest-common/dist cannot find @nestjs/common at
# runtime: it is a peer, and the root node_modules holds only the root's own
# tooling.
#
# `deploy` produces a self-contained directory with a complete, flattened
# node_modules — workspace dependencies included — which is exactly what a
# runtime image needs. Unlike the database-owning services, this step needs no
# Prisma engine cache mount: `deploy` re-runs postinstall scripts, but nothing
# in api-gateway's dependency tree (checked against every packages/*/package.json)
# depends on Prisma.
RUN CI=true pnpm --filter @rasta/api-gateway deploy --prod --legacy /deploy

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
WORKDIR /app

# No `apk upgrade`: the OS layer is exactly the pinned base's (L7-45). A
# rebuild of the same commit therefore produces the same image, and a security
# fix arrives as a deliberate digest bump that the image scan (on every pull
# request that touches this service, and on main) makes visible. The update
# procedure, including the stop-gap when upstream has not rebuilt yet, is in
# docs/runbooks/base-image-update.md.

# Non-root, owning nothing it does not need to write.
#
# The uid is stated rather than left to `adduser -S` to allocate. It lands on
# 100 either way on this base image — matching audit-service and
# notification-service, the two most recently written — but an allocated id
# silently moves the day the base image adds a system user, and 100 is the
# number a deployment manifest asserts against. The *gid* is deliberately not
# pinned: 100 is already `users` in node:22-alpine, so forcing it fails the
# build with `addgroup: gid '100' in use`.
RUN addgroup -S rasta && adduser -S -u 100 -G rasta rasta

# The runtime runs exactly one command: `node dist/main.js`. It has no use for a
# package manager, and shipping one costs twice — npm's own bundled dependencies
# carry CVEs into an image that never calls them, and anything that gains code
# execution finds a ready-made way to fetch more. Removed rather than added to
# an ignore list.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

ENV NODE_ENV=production

COPY --from=build --chown=rasta:rasta /deploy ./

USER rasta

EXPOSE 3000

# Probes readiness rather than liveness, matching every other service here.
# Readiness deliberately does not check downstream services (src/app.module.ts):
# the gateway is up if it can accept and route traffic, so it always answers
# 200 here and reports Redis health inside the body instead of the status code.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/main.js"]
