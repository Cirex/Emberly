# Deployment

The single source of truth for bringing Emberly's production environment online. It covers
the external services (Supabase, Sentry, PostHog) and the four deployables: the **web app**
and the **sync worker** on Coolify, and the **three iOS apps** on EAS.

For per-variable detail, see [[Environment Variables]]. For connecting AI clients to the
deployed MCP server, see [[MCP Server Setup]].

## What deploys where

| Deployable | Package | Platform | Config source |
| --- | --- | --- | --- |
| Admin + resident web + API | `@emberly/web` | Coolify (Dockerfile, build context = **repo root**) | `apps/web/.env.production` |
| ResMan/MLGW sync worker | `@emberly/sync` | Coolify (cron worker, base dir `supabase/sync`) | `supabase/sync/.env` (secret store) |
| Resident iOS app | `@emberly/resident` | EAS Build → App Store | `apps/resident/.env.production` |
| Security/guard iOS app | `@emberly/security` | EAS Build → App Store | `apps/security/.env.production` |
| Maintenance iOS app | `@emberly/maintenance` | EAS Build → App Store | `apps/maintenance/.env.production` |

Each app has a committed `.env.example` and `.env.production.example` listing every variable
it reads. Copy the example to the real (gitignored) file and fill it in, or set the values in
the platform's own secret store.

**Observability is inert by default.** Every app boots and runs with Sentry and PostHog
unconfigured — the SDKs no-op until their keys are set. Bring the deployments up first and
layer observability in afterward.

---

## 1. Supabase (shared database — do this first)

All four deployables talk to one Supabase project.

1. **Create/identify the production project** at [supabase.com](https://supabase.com) (or a
   self-hosted / Coolify Supabase).
2. **Grab the keys** — Project → Settings → API:
   - `SUPABASE_URL` — the Project URL (server-only runtime var).
   - `SUPABASE_SERVICE_ROLE_KEY` — the `service_role` key. **Secret**, bypasses RLS.
     Server/worker only — never in a mobile or browser bundle.
3. **Get the direct DB connection string** — Project → Settings → Database → Connection
   string (URI). This is `SUPABASE_DB_URL`, used **only** to run migrations. It is not part
   of the app runtime env. (Self-hosted/Coolify Postgres often has no TLS on the container —
   if you hit "The server does not support SSL connections", append `?sslmode=disable`.)
4. **Apply migrations.** Migrations live in `apps/web/lib/supabase/migrations` and are
   applied in filename order against a `public.schema_migrations` ledger (each runs once).
   Put `SUPABASE_DB_URL` in `apps/web/.env.production`, then from `apps/web`:
   ```bash
   bun run db:migrate:prod
   ```
   "No migrations to apply" is the normal steady state (applied files get folded into
   `schema.sql` and deleted).
5. **Verify RLS.** Every client-accessible table must have RLS enabled with Storage policies
   that make direct client access safe. The service-role key is the only thing that bypasses
   RLS, and it lives only in the web app and sync worker.

Where these values go:
- **Web (Coolify):** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- **Sync worker (Coolify):** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- **Mobile apps:** none — they reach Supabase only through the web API.

---

## 2. Sentry (crash + error reporting)

Each app reports to its **own** Sentry project — keep them separate so issues are
attributable. Plan on one project per deployable you want coverage for (web, resident,
security, maintenance).

For **each** project:

1. Create the project at [sentry.io](https://sentry.io) (platform: Next.js for web, React
   Native for the mobile apps).
2. Copy the **DSN** — Project → Settings → Client Keys (DSN).
3. For **source-map upload** (optional but recommended), create an org auth token —
   Settings → Auth Tokens — with `project:releases` scope. This is a **secret**.

| Variable | Web | Mobile apps | Notes |
| --- | --- | --- | --- |
| Server/client DSN | `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` | `EXPO_PUBLIC_SENTRY_DSN` | Unset ⇒ Sentry disabled. |
| Trace sample rate | `SENTRY_TRACES_SAMPLE_RATE` | `EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | 0..1; mobile default 0.2. |
| Source-map upload | `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | Build-time only, **not** embedded. Unset ⇒ build still succeeds, no upload. |

On mobile the `@sentry/react-native/expo` plugin reads `SENTRY_ORG` / `SENTRY_PROJECT` /
`SENTRY_AUTH_TOKEN` from the environment at `eas build` time. Set `SENTRY_AUTH_TOKEN` as an
**EAS secret**, never in a committed file.

---

## 3. PostHog (product analytics)

One PostHog project covers the apps (or one per app if you want them siloed — just use
different keys).

1. Create a project at [posthog.com](https://posthog.com) (or self-hosted).
2. Copy the **Project API key** — Project Settings → API key. This is a client key and is
   safe to embed.
3. Note your region host: `https://us.i.posthog.com` (default) or `https://eu.i.posthog.com`.

| Variable | Mobile apps |
| --- | --- |
| `EXPO_PUBLIC_POSTHOG_KEY` | Project API key. Unset ⇒ analytics disabled. |
| `EXPO_PUBLIC_POSTHOG_HOST` | Region host (defaults to US cloud). |

The apps already emit events (`login_success`, `pass_scanned`, `work_order_completed`, etc.)
with no PII, plus `identify`/`reset` on the per-user apps — all gated behind the key being set.

---

## 4. Coolify — web app (`@emberly/web`)

### Why the build context is the repository root (read first)

`apps/web/package.json` declares a workspace dependency, `"@emberly/core": "workspace:*"`.
`@emberly/core` lives at `packages/core`, and the single `bun.lock` lives at the **repository
root** — both are *outside* `apps/web/`. A build whose context is limited to `apps/web/`
cannot resolve the workspace dependency (no lockfile, no `packages/core` to link).

**Consequence:** the Docker build context — equivalently, Coolify's **Base Directory** for
the Dockerfile build pack — **must be the repository root**, with the Dockerfile referenced
at `apps/web/Dockerfile`:

```
<repo root>/                 <-- Docker build context
  bun.lock                   <-- the only lockfile
  package.json               <-- workspace definitions
  apps/web/                  <-- this app (contains the Dockerfile)
  packages/core/             <-- @emberly/core (workspace:* dependency)
```

> A Nixpacks/buildpack build scoped to `/apps/web` will **not** work, for the same reason.
> Use the Dockerfile build pack.

`next.config.mjs` sets `output: "standalone"` and `outputFileTracingRoot` to the repo root,
so the standalone output bundles a minimal `server.js`, the traced `node_modules`, and the
compiled `@emberly/core`.

### Bun is required to build

The whole monorepo runs on Bun (`packageManager: bun@1.3.14`), and the build scripts opt into
the Bun runtime explicitly (`bun --bun next build`, `bun --bun tsc`). The **build environment
must have Bun on PATH**. The Dockerfile uses an `oven/bun` base image for the install/build
stages; `@emberly/core` compiles to a gitignored `dist/` and is built *before* the web app.
The standalone `server.js` is plain Node, so the runtime stage uses a slim `node:22-alpine`
image.

### Build settings (not env vars)

1. **New Resource → Application → from the Git repo.**
2. **Build Pack: Dockerfile.**
3. **Base Directory / build context: the repository root (`/`)** — *not* `/apps/web`. This
   is the critical step (see above).
4. **Dockerfile location:** `apps/web/Dockerfile`.
5. **Port:** `3000`. **Health check path:** `/api/health` (returns `200 {"status":"ok"}`
   with no DB or external dependency).

### Environment variables

Paste `apps/web/.env.production` into Coolify → Environment Variables → **Developer view**
(bulk paste). Tick **"Build Variable"** on every `NEXT_PUBLIC_*` line so it is inlined into
the image at build time. A production web deploy needs, at minimum:

- **Supabase:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- **App runtime:** `NEXT_PUBLIC_APP_URL` (this deploy's public URL — build-time),
  `API_SECRET_KEY`, `MAP_SYNC_HASH_SECRET`, `CRON_SECRET`.
- **Auth/token secrets** (generate each with `openssl rand -base64 32`; in production each
  must be set — the dev fallback is disabled): `ADMIN_SESSION_SECRET`,
  `RESIDENT_SESSION_SECRET`, `SELECTION_TOKEN_SECRET`, `RESIDENT_ENTRY_TOKEN_SECRET`,
  `GUEST_ENTRY_TOKEN_SECRET`, `RESMAN_SESSION_SIGNING_SECRET`, and `SCANNER_SECRET_PEPPER`
  (pick once, **never rotate** — every scanner-device hash derives from it).
- **ResMan portal adapter** (fixed constants): `RESMAN_PORTAL_ORIGIN`,
  `RESMAN_PORTAL_SIGN_IN_PATH`, `RESMAN_PORTAL_TRANSACTIONS_PATH`. Do **not** store ResMan
  API credentials here.
- **Email (Resend):** `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `GUEST_PASS_EMAIL_ORIGIN`.
- **Optional:** `UNIFI_API_KEY` (camera snapshots; blank ⇒ endpoint fails closed with 503),
  Sentry vars (§2).
- Leave `ADMIN_BREAKGLASS_KEY` and `RESIDENT_ALLOWED_PORTAL_STATUSES` blank in production.

The full annotated list is on the [[Environment Variables]] page.

### Cron

Coolify does not inject `CRON_SECRET` or run Vercel-style crons. Pick a `CRON_SECRET` value
yourself and drive the endpoints from an external scheduler (a Coolify scheduled task, or any
cron hitting the URL):

```
GET https://<web-host>/api/cron/cleanup
Authorization: Bearer <CRON_SECRET>
```

### Local Docker build & run (optional)

`apps/web/docker-compose.yml` sets `context: ../..` and `dockerfile: apps/web/Dockerfile`.
From inside `apps/web/`: `docker compose up --build`. Or from the repo root:

```bash
docker build -f apps/web/Dockerfile -t emberly-web .
docker run -p 3000:3000 --env-file apps/web/.env.local emberly-web
```

The container listens on port 3000 and runs as a non-root user.

---

## 5. Coolify — sync worker (`@emberly/sync`)

A long-lived worker that runs the ResMan/MLGW sync pipeline on a schedule. Its credentials
live **only** in Coolify's secret store — never in the web env, never in the iOS apps.

> ### ⚠ Build-context change (do this before the next deploy)
>
> The worker used to build from Base Directory `supabase/sync`. It now ships
> `supabase/sync/Dockerfile`, and — exactly like the web app — **the build context must be
> the repository root**: `@emberly/sync` depends on `@emberly/core` (`workspace:*` at
> `packages/core`) and on the root `bun.lock`, neither of which is visible from
> `supabase/sync/`. The image also installs a system Chromium, which no buildpack provides.
>
> In Coolify, on the existing sync resource, set:
>
> | Setting | Value |
> | --- | --- |
> | Build Pack | **Dockerfile** |
> | Base Directory | `/` (repository root) |
> | Dockerfile Location | `supabase/sync/Dockerfile` |
>
> Local equivalent: `docker build -f supabase/sync/Dockerfile -t emberly-sync .` (from the
> repo root). Leaving the base directory at `supabase/sync` will fail the build.

1. **New Resource → Application** from the repo, Dockerfile build pack, base dir `/`,
   Dockerfile location `supabase/sync/Dockerfile` (see the box above).
2. **Environment variables** — from `supabase/sync/.env.example`:
   - **Required:** `RESMAN_SYNC_USERNAME`, `RESMAN_SYNC_PASSWORD` (the **rotated** password),
     `RESMAN_PROPERTY_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
   - **Optional (have defaults):** `RESMAN_ACCOUNT_ID` (`1659`), `RESMAN_SUBDOMAIN`
     (`multisouth`); MLGW: `MLGW_SYNC_USERNAME`, `MLGW_SYNC_PASSWORD`,
     `MLGW_SYNC_RESTART_ATTEMPTS`, `MLGW_BILL_PAGE_SIZE`, `XMS_MLGW_DEBUG_LOGS`.
   - **Bill capture (set by the image):** `CHROMIUM_PATH=/usr/bin/chromium-browser`. Override
     only if you supply your own browser. If Chromium is missing or fails to launch, the MLGW
     bills job logs one clear line and falls back to the legacy text-transcript invoice PDFs —
     the sync still succeeds, but every PDF-less bill looks alike again.
   - **Sentry (optional):** its own DSN if you want worker error reporting.
3. Configure the run schedule for the worker's sync runners (units, available units, unit
   details/info, lease details, delinquency, work orders, MLGW bills/payments). The image's
   default command, `bun run sync:all:once`, runs the whole sequence; a scheduled task can
   instead invoke one runner, e.g. `bun run src/run-mlgw-bills.ts`.

### MLGW bill capture (what lands in the `mlgw-bills` bucket)

Every bill is stored under one stem, `<yyyyMMdd>-<account>[-<document>]`:

| Object | Content | When |
| --- | --- | --- |
| `<stem>.pdf` | The invoice served by the admin portal (`mlgw_bills.file_path`). MLGW's own PDF when it publishes one, otherwise a Chromium render of the captured bill page. | Always, unless no PDF could be produced at all |
| `<stem>.html` | Self-contained archive of the bill page — stylesheets, images and fonts inlined as `data:` URIs, `<script>` stripped. Needs no network and no session to open. | Every bill MLGW serves as HTML |

The HTML archive is written even when rendering fails, so the bill's real appearance is never
lost. It is an archive, never an invoice: it is deliberately never used as `file_path`.

---

## 6. EAS — the three iOS apps

The mobile apps build with **EAS Build** and are configured through `EXPO_PUBLIC_*`
(embedded) plus build-time Sentry secrets. Full annotated templates: each app's
`.env.production.example`.

### Already in place (committed)

- **`eas.json`** in each app (`apps/resident`, `apps/security`, `apps/maintenance`) with
  `development` (simulator), `preview` (internal device), and `production` (`autoIncrement`)
  profiles. `appVersionSource` is `remote`, so EAS manages build numbers server-side.
- `app.json` bundle IDs: `com.emberly.resident` / `.security` / `.maintenance` (maintenance
  also pins `appleTeamId`).
- `@sentry/react-native/expo` plugin + `ios/sentry.properties` are wired; the plugin uploads
  source maps at build when the Sentry secrets are present. `Sentry.wrap` is gated on the DSN
  so a keyless build is warning-free.

### One-time setup (requires your Expo + Apple login)

1. Sign in: `eas login` (CLI available via `bunx eas-cli`).
2. **Link each app to an EAS project** — run once inside each app dir:
   ```bash
   eas init          # writes owner + extra.eas.projectId into app.json
   ```
3. **Provide the runtime keys.** `.env.production` is gitignored and is NOT uploaded to EAS
   build servers, so cloud builds read `EXPO_PUBLIC_*` from `eas.json` `env` or from EAS
   environment variables. `eas.json` already sets the non-secret defaults. Add the DSN +
   PostHog key either by editing each `eas.json` profile `env` (client keys, safe to commit),
   or via `eas env:create` (EAS rejects empty-string `env` values, so don't add blank keys):
   ```bash
   eas env:create --environment production --name EXPO_PUBLIC_SENTRY_DSN --value <dsn>
   eas env:create --environment production --name EXPO_PUBLIC_POSTHOG_KEY --value <key>
   ```
4. **Set the source-map secret** (real secret — never in `eas.json`):
   ```bash
   eas env:create --environment production --visibility secret --name SENTRY_AUTH_TOKEN --value <token>
   eas env:create --environment production --name SENTRY_ORG --value <org>
   eas env:create --environment production --name SENTRY_PROJECT --value <project>
   ```

### Build & submit

Preferred — `scripts/eas-release.sh` runs the preflight checks first, then builds
(run from the repo root, app dir as the argument):

```bash
scripts/eas-release.sh apps/security --dry-run    # preflight only: version, git, env diff
scripts/eas-release.sh apps/security              # sync env, then build
scripts/eas-release.sh apps/security --submit     # …and submit to TestFlight
```

The preflight refuses to build when the app dir or `packages/` has uncommitted
changes, because **EAS builds your committed git state, not your working tree** —
an uncommitted pod or entitlement produces a binary that is silently missing the
feature. Override with `--allow-dirty` when that is genuinely what you want.

The underlying commands, if you'd rather run them by hand inside the app dir:

```bash
eas build --platform ios --profile production
eas submit --platform ios --profile production   # after the build succeeds
```

### Keeping EAS env vars in sync with the local file

EAS never reads local `.env` files, so the two drift. `scripts/eas-env-sync.sh`
mirrors `<app>/.env.production` into the app's EAS environments — it adds new
variables, updates changed ones, and with `--prune` **deletes variables that are
no longer in the file**:

```bash
scripts/eas-env-sync.sh apps/security --dry-run   # diff only — always safe
scripts/eas-env-sync.sh apps/security             # push adds + updates
scripts/eas-env-sync.sh apps/security --prune     # full mirror (confirms before deleting)
```

Variable **names** and actions are printed; values never are. Names matching
`TOKEN`/`SECRET`/`PASSWORD`/`PRIVATE` are pushed as EAS secrets, except
`EXPO_PUBLIC_*` — Expo inlines those into the client bundle, so calling them
secret would imply a confidentiality the shipped app doesn't have.

Without `--prune`, orphans are reported but left alone. Check what an orphan
does before deleting it: a variable absent from `.env.production` may still be
one the app reads (`grep -r NAME apps/<app>`), or it may be a leftover from
another project.

> `scripts/eas-import-env.sh` is the deprecated predecessor — it pushed a
> hardcoded list of five keys and never removed anything.

### API host

All three default their API host to the built-in `PRODUCTION_ORIGIN` when the override is
unset. Set `EXPO_PUBLIC_API_BASE_URL` (resident) / `EXPO_PUBLIC_BASE_URL` (security,
maintenance) only to point a release at a different origin — e.g. the Coolify web deployment.
Must be `https`.

---

## Go-live checklist

- [ ] Supabase project live; keys collected; **migrations applied**; RLS verified.
- [ ] Sentry projects created; DSNs + (optional) auth tokens collected.
- [ ] PostHog project created; API key + host collected.
- [ ] Web app deployed on Coolify (root build context, port 3000, `/api/health` green); all
      required env vars set; `NEXT_PUBLIC_*` flagged as build vars.
- [ ] External scheduler hitting `/api/cron/cleanup` with the `CRON_SECRET` bearer.
- [ ] Sync worker deployed on Coolify with the rotated ResMan credentials; schedule running.
- [ ] `eas init` run in each mobile app; DSN/PostHog key + Sentry source-map secret provided.
- [ ] Each iOS app built (`eas build`) and submitted (`eas submit`).
- [ ] Smoke test: admin login, resident login, a scan, a work-order open — confirm events
      land in PostHog and a forced test error lands in Sentry.
