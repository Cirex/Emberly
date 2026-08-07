# syntax=docker/dockerfile:1
#
# Multi-stage build for @emberly/sync (the ResMan + MLGW sync worker) in the Bun
# monorepo.
#
# ============================================================================
# ⚠ DEPLOYMENT CHANGE — ACTION REQUIRED IN COOLIFY BEFORE THE NEXT DEPLOY
# ============================================================================
# The sync worker previously had NO Dockerfile: Coolify built it with a
# buildpack from Base Directory `supabase/sync`. That no longer works, for two
# independent reasons:
#
#   1. @emberly/sync depends on the workspace package `@emberly/core`
#      (`"@emberly/core": "workspace:*"`), which lives at `packages/core`, and
#      the single `bun.lock` lives at the repository ROOT. A build scoped to
#      `supabase/sync/` can see neither.
#   2. The worker now renders MLGW bill pages to PDF with a system Chromium
#      (installed below). A buildpack image has no browser.
#
# In Coolify, switch this resource to:
#     Build Pack:          Dockerfile
#     Base Directory:      /            (the repository ROOT — the build context)
#     Dockerfile Location: supabase/sync/Dockerfile
#
# Equivalent local build (note the trailing `.` — context is the repo root):
#     docker build -f supabase/sync/Dockerfile -t emberly-sync .
#
#     <repo root>/                <-- Docker build context
#       bun.lock                  <-- the only lockfile
#       package.json              <-- workspace definitions
#       packages/core/            <-- @emberly/core (workspace:* dependency)
#       supabase/sync/            <-- this worker (contains this Dockerfile)
#
# Environment: unchanged from the buildpack deploy (RESMAN_*, MLGW_*,
# SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY …), plus `CHROMIUM_PATH`, which this
# image sets for you. See docs/Deployment.md §5.
# ============================================================================
#
# The worker runs TypeScript natively under Bun (no transpile step — see
# AGENTS.md), so Bun is the runtime as well as the installer. Only
# `@emberly/core` is compiled ahead of time, because @emberly/sync imports it
# through its `dist/`.

# Pin to the version in the root package.json "packageManager" field.
ARG BUN_VERSION=1.3.14

# ---------- build: install the workspace and compile @emberly/core -------------
FROM oven/bun:${BUN_VERSION}-alpine AS build
WORKDIR /app

# Manifests + lockfile first so the install layer caches until a dependency
# changes. Every workspace manifest is required for a --frozen-lockfile install
# to reconcile against bun.lock.
#
# ADDING A NEW APP? Add its package.json here too. The workspaces globs are
# `apps/*`, `packages/*`, `supabase/sync`, so a new workspace lands in bun.lock
# immediately, and a frozen install that cannot see its manifest fails the
# build — the sync image breaks on a change that never touched the worker.
COPY package.json bun.lock turbo.json tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/resident/package.json ./apps/resident/
COPY apps/security/package.json ./apps/security/
COPY apps/maintenance/package.json ./apps/maintenance/
COPY apps/manager/package.json ./apps/manager/
COPY packages/core/package.json ./packages/core/
COPY packages/ui/package.json ./packages/ui/
COPY supabase/sync/package.json ./supabase/sync/

# --ignore-scripts skips the mobile workspaces' postinstall (they need mobile
# source this image never copies). No sync dependency needs an install-time
# lifecycle script — in particular `playwright-core` (unlike `playwright`)
# downloads NO browsers, which is exactly why the worker depends on it and
# points Playwright at the distro Chromium installed in the runtime stage.
RUN bun install --frozen-lockfile --ignore-scripts

# Full monorepo source (Dockerfile.dockerignore keeps artifacts out).
COPY . .

# @emberly/sync resolves @emberly/core through its compiled dist/ (gitignored),
# so core must be built here. The worker's own TypeScript is executed directly
# by Bun and needs no build.
RUN bun run --filter '@emberly/core' build

# ---------- runtime: Bun + a system Chromium, running as a non-root user -------
FROM oven/bun:${BUN_VERSION}-alpine AS runtime
ENV NODE_ENV=production

# Chromium for the MLGW bill-page → PDF renderer, plus the libraries and FONTS
# it needs. Without font packages a headless render shows tofu boxes instead of
# text — `font-noto` (broad Unicode coverage) and `ttf-freefont` (the standard
# serif/sans/mono families bill stylesheets ask for) are NOT optional.
# `chromium` provides both /usr/bin/chromium-browser and /usr/bin/chromium.
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      freetype-dev \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
      font-noto \
  && rm -rf /var/cache/apk/*

# Consumed by src/mlgw/capture/chromium-path.ts. The resolver falls back to the
# same paths on its own, but setting it explicitly documents the contract and
# makes a broken image fail loudly rather than silently degrade to text
# transcripts.
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

# Run as an unprivileged user. Chromium is launched with --no-sandbox (the
# container already provides the isolation boundary, and the setuid sandbox is
# unavailable to a non-root user in a default Docker seccomp profile).
RUN addgroup -g 1001 -S emberly \
  && adduser -S emberly -u 1001 -G emberly

# The whole installed workspace is copied as one tree. Bun installs into
# node_modules/.bun and symlinks to it; copying node_modules PIECEMEAL across
# stages yields dangling links (see the sharp note in apps/web/Dockerfile), so
# the tree is copied whole, at the same /app path it was installed at.
COPY --from=build --chown=emberly:emberly /app /app

WORKDIR /app/supabase/sync
USER emberly

# Idle by default. The work is driven by Coolify scheduled tasks that `exec`
# into this container, e.g.
#   bun run src/run-mlgw-bills.ts
#
# This used to be `CMD ["bun", "run", "sync:all:once"]`, which could not work as
# a Coolify Application: that command runs one pass and EXITS, and an
# Application that exits reads as a crash — so Coolify restarted it, on success
# exactly as on failure, until it hit the 10/10 restart limit and gave up. A
# missing env var made it fail in about a second and burn all ten restarts
# immediately; a correct environment would instead have looped full ResMan
# scrapes back to back. Either way the container was never up long enough to be
# a target for the scheduled tasks that are supposed to drive it.
#
# Overriding the command in Coolify's UI does not fix this: its custom start
# command applies to the Docker Compose build pack, not to Dockerfile builds,
# where the image CMD wins (coollabsio/coolify#1689). So the keepalive has to
# live here, where nothing in the UI can override it.
#
# A one-shot full pass is still available on demand — the image just needs to be
# told to do it rather than defaulting to it:
#   docker run --env-file .env emberly-sync bun run sync:all:once
#
# `sync:all:once` remains the container form of `sync:all`: identical runners,
# but it reads configuration from the process environment (Coolify's secret
# store) instead of a `.env` file that does not exist in the image. Every other
# `sync:*` script carries `--env-file=.env` and CANNOT run in this image for
# that reason — scheduled tasks must invoke `src/run-*.ts` directly.
CMD ["sleep", "infinity"]
