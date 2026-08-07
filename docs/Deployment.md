# Deployment

The single source of truth for bringing Emberly's production environment online. It covers
the external services (Supabase, Sentry, PostHog) and the four deployables: the **web app**
and the **sync worker** on Coolify, and the **three iOS apps** on EAS.

For per-variable detail, see [[Environment Variables]]. For connecting AI clients to the
deployed MCP server, see [[MCP Server Setup]].

## Versioning

```bash
bun run version                      # every app, and any drift
bun run version security patch       # 2.0.1 → 2.0.2
bun run version manager minor        # 1.0.0 → 1.1.0
bun run version resident major       # 1.0.0 → 2.0.0
bun run version security --set 2.1.0 # exact — for reconciling drift
bun run version security patch --dry-run
```

**A version is not in one file.** An Expo app here carries it in four, and
nothing else keeps them in step:

| where | what reads it |
| --- | --- |
| `package.json` → `version` | workspace metadata only |
| `app.json` → `expo.version` | Expo tooling |
| `ios/<App>/Info.plist` → `CFBundleShortVersionString` | **what ships** |
| `ios/<App>.xcodeproj/project.pbxproj` → `MARKETING_VERSION` ×2 | **what ships** |

The last two matter most. `ios/` is **committed** in this repo, so EAS treats
these as bare projects and does not run `expo prebuild` — the native values are
what reach TestFlight, and `app.json` never gets read. Bumping `app.json` alone
ships the old version under a new number in the changelog, which nobody notices
until a crash report points at a build that supposedly does not exist.

All four apps were drifted when this tool was written: `security` was `1.0.0` in
`package.json` and `2.0.1` everywhere else, and `maintenance` / `manager` /
`resident` had `MARKETING_VERSION` at `1.1` / `1.0` / `1.0` against `x.y.0` in
the plist. All reconciled to what actually ships.

Build numbers are **not** touched — `eas.json` sets
`appVersionSource: "remote"` with `autoIncrement`, so EAS owns `CFBundleVersion`.
Writing it here would fight the service that already manages it.

## What deploys where

| Deployable | Package | Platform | Config source |
| --- | --- | --- | --- |
| Admin + resident web + API | `@emberly/web` | Coolify (Dockerfile, build context = **repo root**) | `apps/web/.env.production` |
| ResMan/MLGW sync worker | `@emberly/sync` | Coolify (idle container + scheduled tasks; base dir `/`, Dockerfile `supabase/sync/Dockerfile`) | `supabase/sync/.env` (secret store) |
| Resident iOS app | `@emberly/resident` | EAS Build → App Store | `apps/resident/.env.production` |
| Security/guard iOS app | `@emberly/security` | EAS Build → App Store | `apps/security/.env.production` |
| Maintenance iOS app | `@emberly/maintenance` | EAS Build → App Store | `apps/maintenance/.env.production` |

One committed `.env.example` at the repo root lists every variable every app reads,
grouped by layer. The real files are **generated** — edit the gitignored sources at the
repo root (`.env.mobile`, `.env.<app>`, `.env.<app>.local`) and run `bun run env:build`.
See [[Environment Variables]].

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
4. **Apply migrations.** Migrations live in `apps/web/lib/supabase/deltas` and are
   applied in filename order against a `public.schema_migrations` ledger (each runs once).
   Put `SUPABASE_DB_URL` in `apps/web/.env.production`, then from `apps/web`:
   ```bash
   bun run db:migrate:prod
   ```
   Deltas are kept on disk after they run, so the ledger — not the directory — decides
   what is still pending. "Already up to date." is the normal steady state.
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
3. **Scheduled tasks.** The container idles (`CMD ["sleep", "infinity"]`) and the work is
   driven by Coolify scheduled tasks that `exec` into it. That indirection is not
   decoration — see the comment at the bottom of the Dockerfile: a container whose command
   runs a pass and exits reads as a crash to Coolify and gets restart-looped until it hits
   the 10/10 limit, and Coolify's custom-start-command field cannot override a Dockerfile
   build's `CMD`.

   **Commands must call `src/run-*.ts` directly.** Every `sync:*` package script except
   `sync:all:once`, `sync:units` and `sync:dev` carries `--env-file=.env`, and there is no
   `.env` in the image — Coolify supplies configuration through the process environment, so
   those scripts exit immediately. `WORKDIR` is already `/app/supabase/sync`, so relative
   paths work as written, and **Container name** stays blank.

   Runners have a dependency order — units before the reports that enrich them, MLGW last
   because `syncMlgwBills` reads `resman_units` for address→unit matching. Chain each group
   with `&&` so a failure stops the group and the task's exit code turns the run red:

   Cron has no timezone — it fires on the **server** clock. The times below are UTC, with
   the property-local equivalent noted, because the container runs UTC while the property is
   Central. They shift by an hour when DST ends unless Coolify's timezone field is set.

   | Name | Command | Frequency (UTC) | Local | Timeout |
   | --- | --- | --- | --- | --- |
   | `sync-core` | `bun run src/run-units.ts && bun run src/run-unit-info.ts && bun run src/run-available-units.ts && bun run src/run-delinquency.ts` | `13 * * * *` | hourly | 600 |
   | `sync-work-orders` | `bun run src/run-work-orders.ts && bun run src/run-translate-work-orders.ts` | `*/15 * * * *` | every 15 min | 300 |
   | `sync-unit-details` | `sh -c 'set -o pipefail; bun run src/run-unit-details.ts 2>&1 \| tee /proc/1/fd/1'` | `11 5,17 * * *` | 12:11 AM, 12:11 PM | — |
   | `sync-lease-details` | `sh -c 'set -o pipefail; bun run src/run-lease-details.ts 2>&1 \| tee /proc/1/fd/1'` | `23 6,18 * * *` | 1:23 AM, 1:23 PM | — |
   | `sync-mlgw` | `sh -c 'set -o pipefail; { bun run src/run-mlgw-bills.ts && bun run src/run-mlgw-payments.ts; } 2>&1 \| tee /proc/1/fd/1'` | `23 7 * * *` | 2:23 AM | 14400 |
   | `sync-derived` | `bun run src/run-pm-generate.ts && bun run src/run-manager-alerts.ts && bun run src/run-snapshots.ts && bun run src/run-unit-snapshots.ts` | `31 14 * * *` | 9:31 AM | 900 |

   **The deep scrape is TWO tasks, not one chain, and that is not cosmetic.** Coolify wraps
   each scheduled task in `timeout 3600` on its SSH invocation — observed in `ps`, and NOT
   the per-task timeout field, which was set to 36000 and had no effect. Chained, the pair
   runs ~1h45m (measured: ~20 units/min over 891, ~13 leases/min over 750) and is killed at
   the hour mark every time. Worse, `timeout` kills the SSH client while `docker exec` leaves
   the container process running, so each killed run leaves an ORPHAN still scraping — one
   was found at 45 minutes old, competing with a fresh chain for the same rate limit. Split,
   each task finishes inside the hour.

   Find orphans with `ps -eo pid,ppid,etime,args | grep "[r]un-"`. Kill the `bun` process,
   not its shells — the shells are only waiting on it and exit by themselves, while killing
   them leaves the scraper running.

   The **timeout** column is not advisory. The 300s default cuts the deep scrape (891 unit
   pages) and MLGW (3,542 bill downloads) off mid-run; both are set to 4h here. Check the
   first run's real duration and adjust. `run-owner-report.ts` and `run-snapshots-backfill.ts`
   are on-demand and deliberately absent.

   #### Watching a long run while it happens

   Coolify buffers a scheduled task's output and shows it only once the task ends, which is
   no use on a job that runs for hours. The two long groups above therefore pipe through
   `tee /proc/1/fd/1`: PID 1 is the container's `sleep infinity`, and its stdout **is** the
   container log stream, so their output appears live in the resource's **Logs** tab while
   still being captured in the task's own execution record.

   Three things make that work, all verified against the image:

   - `run-unit-details` logs per unit (`→ [37/891] 1710 CW-4`, then `✓ …`) and the MLGW job
     logs per collection and per bill, so there is real progress to watch. `sync-core` is not
     piped because it has none — its runners are one CSV fetch and a summary line.
   - Bun line-buffers even through a pipe, so lines appear as they are printed rather than in
     a block at the end.
   - **`set -o pipefail` is required.** `tee` is the last command in the pipeline, so without
     it the task's exit code is `tee`'s — always 0 — and a failed sync reports green. That
     would silently undo the `&&` chaining this whole table depends on.

   Only the long groups are piped on purpose: sending all five to the container log would
   interleave five schedules into one stream, and `sync-work-orders` alone would post every
   15 minutes.

   For a run you are actively babysitting, skip all of this and run the command from the
   resource's **Terminal** tab — output streams to your screen and you can interrupt it,
   which a scheduled task cannot.

   To confirm a task is landing in the right container before pasting a real command, run
   `sh -c 'echo PWD=$PWD; command -v bun'` — expect `/app/supabase/sync` and
   `/usr/local/bin/bun`. `PWD=/app` with no bun means the task is on the **web** resource.

   A one-shot full pass on demand: `docker run --env-file .env emberly-sync bun run sync:all:once`.

### Syncing environment variables

Both Coolify resources were configured by typing into a web form, with nothing to diff them
against. `bun run env:coolify` mirrors the local file into the resource over the Coolify API
and, crucially, tells you when they disagree:

```bash
bun run env:coolify sync --dry-run    # diff only — always safe, values never printed
bun run env:coolify sync              # push adds + updates
bun run env:coolify web --prune       # full mirror (confirms before deleting)
```

`sync` reads `supabase/sync/.env`; `web` reads `apps/web/.env.production`. On the web target
every `NEXT_PUBLIC_*` is pushed with `is_build_time` set, so the "Build Variable" tick above
is no longer a thing anyone has to remember — forgetting it is silent, and the variable is
simply undefined in the browser bundle.

Configure it once in a gitignored `.env.coolify` at the repo root:

```
COOLIFY_URL=https://coolify.example.com
COOLIFY_API_TOKEN=...      # Keys & Tokens -> API tokens (needs write)
COOLIFY_WEB_UUID=...       # each resource's uuid, from its Coolify URL
COOLIFY_SYNC_UUID=...
```

Changes take effect on the next deploy of the resource, not immediately.

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

Preferred — `bun run release <app>`, the front door for every app including web.
It checks the version is unambiguous, then hands mobile apps to
`bun run release:eas` and web to Vercel:

```bash
bun run release security --dry-run   # preflight only, ships nothing
bun run release security --submit    # build → TestFlight
bun run release web --preview        # preview URL
bun run release web                  # production (prompts first)
```

It refuses to ship an app whose version disagrees with itself — see
[Versioning](#versioning) for why that is a real failure mode rather than
tidiness.

`bun run release:eas` is still there and unchanged if you want the mobile
path directly (run from the repo root, app dir as the argument):

```bash
bun run release:eas apps/security --dry-run    # preflight only: version, git, env diff
bun run release:eas apps/security              # sync env, then build
bun run release:eas apps/security --submit     # …and submit to TestFlight
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

EAS never reads local `.env` files, so the two drift. `bun run env:eas`
mirrors `<app>/.env.production` into the app's EAS environments — it adds new
variables, updates changed ones, and with `--prune` **deletes variables that are
no longer in the file**:

```bash
bun run env:eas apps/security --dry-run   # diff only — always safe
bun run env:eas apps/security             # push adds + updates
bun run env:eas apps/security --prune     # full mirror (confirms before deleting)
```

Variable **names** and actions are printed; values never are. Names matching
`TOKEN`/`SECRET`/`PASSWORD`/`PRIVATE` are pushed as EAS secrets, except
`EXPO_PUBLIC_*` — Expo inlines those into the client bundle, so calling them
secret would imply a confidentiality the shipped app doesn't have.

Without `--prune`, orphans are reported but left alone. Check what an orphan
does before deleting it: a variable absent from `.env.production` may still be
one the app reads (`grep -r NAME apps/<app>`), or it may be a leftover from
another project.

> Its deprecated predecessor `eas-import-env.sh` — which pushed a hardcoded list
> of five keys and never removed anything — has been deleted.

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
