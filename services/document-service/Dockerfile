# syntax=docker/dockerfile:1.7
# =============================================================================
# document-service
#
# Built from the repository root, because a pnpm workspace resolves through the
# root lockfile and the linked @rasta/* packages. Building from the service
# directory would produce an image that cannot see its own dependencies.
#
# The reasoning behind each stage is the same as asset-service's, and each
# comment below records a failure that actually happened when these images were
# first built — they are kept so the next service does not rediscover them.
# =============================================================================

# ---- deps -------------------------------------------------------------------
FROM node:22-alpine AS deps

# pnpm is installed directly rather than through corepack. Corepack downloads
# the tarball at build time and crashes intermittently doing so
# (`AssertionError: assert(!this.paused)`), which turns an image build into a
# coin flip. A pinned npm install is deterministic and needs no TTY.
RUN npm install -g pnpm@11.22.0

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"

# The whole workspace is copied before installing, not just this service's
# manifest. `--frozen-lockfile` validates the lockfile against every project
# the workspace globs match, so a partial copy reads as a lockfile mismatch
# and fails.
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

# Generates the Prisma client, then compiles this service and its dependencies
# in dependency order.
RUN pnpm --filter @rasta/document-service... build

# `pnpm deploy` rather than `prune`, and the difference matters.
#
# pnpm's isolated node_modules layout means a workspace package resolves its
# peer dependencies through the *consumer*, not through its own directory. So
# a naively copied packages/nest-common/dist cannot find @nestjs/common at
# runtime: it is a peer, and the root node_modules holds only the root's own
# tooling.
#
# `deploy` produces a self-contained directory with a complete, flattened
# node_modules — workspace dependencies included — which is exactly what a
# runtime image needs.
# The Prisma engine cache is mounted here too: `deploy` re-runs postinstall
# scripts, and re-downloading the engine binary makes the build depend on a
# CDN staying up.
RUN --mount=type=cache,id=prisma-engines,target=/root/.cache/prisma \
    CI=true pnpm --filter @rasta/document-service deploy --prod --legacy /deploy

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# Apply whatever OS patches Alpine has published since this base image was
# cut. The base tag moves slower than the security feed, so a freshly built
# image can already carry a fixed-upstream CVE. Deliberately unpinned:
# reproducibility of the OS layer is worth less than shipping a patched one,
# and the Trivy scan in CI still fails the build if anything fixed remains.
RUN apk --no-cache upgrade

# Non-root, owning nothing it does not need to write.
RUN addgroup -S rasta && adduser -S rasta -G rasta

# The runtime runs exactly one command: `node dist/main.js`. It has no use for
# a package manager, and shipping one costs twice — npm's own bundled
# dependencies carry CVEs into an image that never calls them, and anything
# that gains code execution finds a ready-made way to fetch more. Removed
# rather than added to an ignore list.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

ENV NODE_ENV=production

COPY --from=build --chown=rasta:rasta /deploy ./

USER rasta

EXPOSE 3114

# Probes readiness, not liveness: an unhealthy database should mark the
# container unhealthy rather than leave it in rotation answering 500s.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3114)+'/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/main.js"]
