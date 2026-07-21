# syntax=docker/dockerfile:1
#
# Multi-stage build for @emberly/web (Next.js standalone output) in the Bun
# monorepo.
#
# IMPORTANT — THE BUILD CONTEXT MUST BE THE REPOSITORY ROOT.
# @emberly/web depends on the workspace package `@emberly/core`
# (`"@emberly/core": "workspace:*"`), which lives at `packages/core`. The
# single `bun.lock` also lives at the repo root. A build whose context is only
# `apps/web/` cannot see either, so `bun install` cannot resolve the workspace
# dependency. Build from the repository root:
#
#     docker build -f apps/web/Dockerfile -t emberly-web .
#
# In Coolify (Dockerfile build pack): set the Base Directory / build context to
# the repository ROOT and the Dockerfile Location to `apps/web/Dockerfile`.
# See apps/web/DEPLOY.md.
#
# Bun is required for install AND build: the build scripts opt into the Bun
# runtime via `bun --bun next build` / `bun --bun tsc` (see AGENTS.md). The
# Next.js standalone server (`server.js`) is plain Node and is served by Node in
# the runtime stage to keep the final image minimal.

# Pin to the version in the root package.json "packageManager" field.
ARG BUN_VERSION=1.3.14
ARG NODE_VERSION=22

# ---------- build: install the workspace, then compile core + the web app ------
# Install and build run in the same stage on purpose: Bun does not hoist every
# dependency to the root node_modules (e.g. `next` is nested under
# apps/web/node_modules). Copying only the root node_modules across stages would
# drop those nested trees, so the whole build stage is discarded anyway — only
# the standalone output is carried into the runtime stage below.
FROM oven/bun:${BUN_VERSION}-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Copy only manifests + lockfile first so the install layer caches until a
# dependency changes. Every workspace manifest is required for a
# --frozen-lockfile install to reconcile against bun.lock.
#
# ADDING A NEW APP? Add its package.json here too. The workspaces globs are
# `apps/*`, `packages/*`, `supabase/sync`, so a new workspace lands in bun.lock
# immediately, and a frozen install that cannot see its manifest fails the
# build — the web image breaks on a change that never touched the web app.
COPY package.json bun.lock turbo.json tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/resident/package.json ./apps/resident/
COPY apps/security/package.json ./apps/security/
COPY apps/maintenance/package.json ./apps/maintenance/
COPY apps/manager/package.json ./apps/manager/
COPY packages/core/package.json ./packages/core/
COPY packages/ui/package.json ./packages/ui/
COPY supabase/sync/package.json ./supabase/sync/

# --ignore-scripts skips the mobile workspace's postinstall (it needs mobile
# source we intentionally don't copy yet, and the web image never runs mobile).
# No web dependency requires an install-time lifecycle script.
RUN bun install --frozen-lockfile --ignore-scripts

# Copy the full monorepo source. .dockerignore keeps node_modules/.next/.turbo
# and other artifacts out of the context.
COPY . .

# @emberly/core resolves via its compiled dist/ (gitignored), so it must be
# built before the web app. next.config.mjs uses output: "standalone" with
# outputFileTracingRoot = repo root, so the standalone tree bundles core.
RUN bun run --filter '@emberly/core' build \
  && bun run --filter '@emberly/web' build

# Stage sharp for the runtime image. The camera snapshot route resolves sharp
# through createRequire at runtime, which output-file tracing cannot follow, so
# sharp never lands in the standalone output on its own. Bun installs into
# node_modules/.bun and symlinks to it; that store directory holds sharp
# alongside its own dependencies (@img/* platform binaries, detect-libc,
# semver), which is exactly the layout Node's resolver needs. Resolving the
# symlink instead of hardcoding `sharp@<version>` keeps this working across
# upgrades, and @img carries whichever binary bun selected for the build
# platform, so nothing here is architecture-specific.
# -L dereferences: inside the store only `sharp` itself is a real directory —
# its siblings (@img, detect-libc, semver) are symlinks to their own store
# entries, and copying those as links yields danglers that fail at require time.
RUN SHARP_DEPS="$(dirname "$(readlink -f /app/apps/web/node_modules/sharp)")" \
  && mkdir -p /sharp-runtime \
  && cp -RL "$SHARP_DEPS"/. /sharp-runtime/ \
  && for d in sharp @img detect-libc semver; do \
       test -d "/sharp-runtime/$d" || { echo "sharp staging incomplete: $d missing"; exit 1; }; \
     done

# ---------- runtime: minimal non-root Node image serving standalone server -----
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as an unprivileged user.
RUN addgroup -g 1001 -S nodejs \
  && adduser -S nextjs -u 1001

# With outputFileTracingRoot = repo root, the standalone tree is rooted at the
# workspace: it contains apps/web/server.js, the traced node_modules, and the
# bundled @emberly/core. Copy it to /app, then layer in the static assets and
# public files Next does not include in the standalone trace.
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

# sharp + its platform binaries, staged in the build stage above. The
# standalone server chdirs to apps/web, so this is the first place Node's
# resolver looks. Failure here is SILENT at runtime — the route catches it and
# serves full-size frames — so verify explicitly after changing this:
#   docker run --rm --entrypoint sh <image> \
#     -c 'cd /app/apps/web && node -e "require(\"sharp\");console.log(\"ok\")"'
COPY --from=build --chown=nextjs:nodejs /sharp-runtime ./apps/web/node_modules

USER nextjs
EXPOSE 3000

# No-dependency liveness probe (mirrors Coolify's health check path).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The standalone entrypoint lives under apps/web/ because of the tracing root.
CMD ["node", "apps/web/server.js"]
