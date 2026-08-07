# Environment Variables

Every variable each deployable reads, where it goes, and which are secret. Each app ships a
committed template — copy it and fill in what you need:

Environment files are **generated**. Edit the gitignored layered sources at the repo
root and run `bun run env:build`:

| Source | Feeds |
| --- | --- |
| `.env.mobile` | resident / security / maintenance |
| `.env.<app>` | that app's `.env.production` (or `supabase/sync/.env`) |
| `.env.<app>.local` | that app's `.env.local` overlay |

`bun run env:build --check` reports drift without writing. The single committed
template is `.env.example` at the repo root, generated from these sources plus the
prose in this document — so documenting a variable here is what makes it appear there.

**Guiding rules**

- **Everything is inert until set.** Every app boots and runs with an empty env; missing keys
  just disable the related feature (Sentry, PostHog, UniFi, Resend all no-op).
- **`NEXT_PUBLIC_*` and `EXPO_PUBLIC_*` are public** — inlined into the client bundle at build
  time. Never put a secret behind those prefixes; anyone can read them out of the shipped app.
- **Secrets** (service-role key, session secrets, Resend key, ResMan/MLGW passwords, Sentry
  auth token) live only in server/build environments or the platform's secret store — never
  committed, never in a mobile bundle.
- **`.env*` files are gitignored** and must never be committed. Keep the `.example` files
  current with public placeholders only.

Generate the web app's auth secrets with `openssl rand -base64 32` (one unique value each).

---

## `@emberly/web`

The web app reads everything at runtime; `NEXT_PUBLIC_*` values are also inlined at build
time. The app boots with everything unset — missing keys just disable the related feature.

### Supabase

| Var | Secret? | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | server-only | Project URL. Legacy alias `NEXT_PUBLIC_SUPABASE_URL` still accepted. |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret** | Bypasses RLS. Server-only. |
| `SUPABASE_DB_URL` | **secret** | Direct Postgres URL — only for running migrations, not app runtime. |

> No `NEXT_PUBLIC_SUPABASE_ANON_KEY`: the web app is server-side only (service-role
> client + API routes) with no browser Supabase client, and the mobile apps reach
> Supabase only through the web API — so the anon key is not used anywhere.

### App runtime

| Var | Secret? | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_URL` | public | Public base URL of this deploy (build-time). |
| `API_SECRET_KEY` | **secret** | Server API secret. |
| `MAP_SYNC_HASH_SECRET` | **secret** | Map-sync signing secret. |
| `CRON_SECRET` | **secret** | Bearer for `/api/cron/*`. On Coolify, set it yourself and drive crons from an external scheduler. |

### Auth & token secrets

Generate each with `openssl rand -base64 32`. In production every one must be set — the dev
fallback is disabled.

| Var | Notes |
| --- | --- |
| `SCANNER_SECRET_PEPPER` | HMAC secret the stored scanner `secret_hash` derives from. **Pick once, never rotate** — changing it invalidates every issued scanner key. Scanner keys themselves are not env config; they live only in the `scanner_devices` table and are minted (shown once) from the admin Scanners page. |
| `ADMIN_SESSION_SECRET` | Admin session signing. Staff log in with ResMan **staff** credentials; an `admin_users` row is created on first login. No shared admin password. |
| `ADMIN_BREAKGLASS_KEY` | Emergency break-glass only. Leave **blank** to disable (default). When set, grants super_admin via the login form's emergency-key field. Rotate/unset after use. |
| `RESIDENT_SESSION_SECRET` | Resident session signing. |
| `SELECTION_TOKEN_SECRET` | Selection-token signing. |
| `RESIDENT_ENTRY_TOKEN_SECRET` | Resident entry-token signing. |
| `GUEST_ENTRY_TOKEN_SECRET` | Guest entry-token signing. |
| `RESMAN_SESSION_SIGNING_SECRET` | ResMan session signing. |
| `RESMAN_SESSION_SIGNATURE_MAX_AGE_MS` | ResMan session lifetime (default `604800000` = 7 days). |
| `RESIDENT_ACCESS_MAX_AGE_MS` | Resident access-token lifetime (default `1200000` = 20 min). |

The private REST API (`/api/resman/*`, `/api/mlgw/*`) has **no shared key**: access is by a
per-user API token (`eapi_…`, minted on the admin Access Tokens page) or a scanner credential
(`?scannerId=<id>` + the scanner secret). It fails closed.

### ResMan portal adapter (fixed constants)

| Var | Notes |
| --- | --- |
| `RESMAN_PORTAL_ORIGIN` | e.g. `https://multisouth.myresman.com`. |
| `RESMAN_PORTAL_SIGN_IN_PATH` | Portal sign-in path. |
| `RESMAN_PORTAL_TRANSACTIONS_PATH` | Portal transactions path. |

Do **not** store ResMan API credentials in the web env — the sync worker owns those.

### Resident login gate

| Var | Notes |
| --- | --- |
| `RESIDENT_ALLOWED_PORTAL_STATUSES` | Residents may sign in only when their ResMan portal status is Current, Pending Renewal, or Under Eviction. This *adds* extra statuses (comma-separated, case-insensitive) for testing with non-active accounts. **Leave blank in production.** |

### Email (Resend)

| Var | Secret? | Notes |
| --- | --- | --- |
| `RESEND_API_KEY` | **secret** | Resend API key. |
| `RESEND_FROM_EMAIL` | public | From address for guest-pass email. |
| `GUEST_PASS_EMAIL_ORIGIN` | public | Origin used in guest-pass email links. |

### UniFi Protect (camera snapshots)

| Var | Secret? | Notes |
| --- | --- | --- |
| `UNIFI_API_KEY` | **secret** | Holds the UniFi cloud API key server-side so it never ships to the guard app. Blank ⇒ the snapshot endpoint fails closed with 503. Mint at `unifi.ui.com → API → Create API Key` on the account that owns the console (remote access enabled). |

### Sentry (all optional — unset ⇒ fully disabled, build still works)

| Var | Secret? | Notes |
| --- | --- | --- |
| `SENTRY_DSN` | public | Server DSN. |
| `NEXT_PUBLIC_SENTRY_DSN` | public | Browser DSN (usually the same value). |
| `SENTRY_ENVIRONMENT` / `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | public | Optional env label (defaults to `NODE_ENV`). |
| `SENTRY_TRACES_SAMPLE_RATE` / `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | public | 0..1, default 0 (tracing off). |
| `SENTRY_AUTH_TOKEN` | **secret** | Source-map upload only. Unset ⇒ `next build` skips upload and still succeeds. |
| `SENTRY_ORG`, `SENTRY_PROJECT` | public | Used only for source-map upload. This is one of several separate Sentry projects — use this project's values. |

> Deployment-only values (`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`) are not part
> of the app runtime env. `vercel.json` is legacy; Coolify is the supported path.

---

## The three iOS apps (`@emberly/resident`, `@emberly/security`, `@emberly/maintenance`)

All three share the same shape. `EXPO_PUBLIC_*` vars are embedded in the app bundle at build
time (never secret); the build-only Sentry vars upload source maps during `eas build` and are
never embedded.

### API host

| App | Var | Notes |
| --- | --- | --- |
| Resident | `EXPO_PUBLIC_API_BASE_URL` | Local: `http://localhost:3001/api`. Prod: defaults to the built-in `PRODUCTION_ORIGIN`/api; override to point at another origin (must be https). Also `EXPO_PUBLIC_API_PORT` for local dev. |
| Security | `EXPO_PUBLIC_BASE_URL` | Local: `http://localhost:3001`. Prod: defaults to `PRODUCTION_ORIGIN`; override to another origin (https). |
| Maintenance | `EXPO_PUBLIC_BASE_URL` | Same as Security. Plus `EXPO_PUBLIC_DEV_TOKEN` — a **dev-only** bearer that skips sign-in locally; must stay unset in any build. |

> The **Security** app's device auth is a per-device **scanner key** entered on the Setup
> screen and stored in the Keychain — it is not an env var and never appears in a template.

### Sentry (runtime — all optional)

| Var | Notes |
| --- | --- |
| `EXPO_PUBLIC_SENTRY_DSN` | This app's own Sentry project DSN. Unset ⇒ Sentry init skipped. |
| `EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | 0..1, default 0.2 when a DSN is set. |

### PostHog (runtime — all optional)

| Var | Notes |
| --- | --- |
| `EXPO_PUBLIC_POSTHOG_KEY` | Project API key. Unset ⇒ `capture()` is a no-op. |
| `EXPO_PUBLIC_POSTHOG_HOST` | Defaults to `https://us.i.posthog.com`; use `https://eu.i.posthog.com` for EU. |

### Sentry source-map upload (BUILD ONLY — not embedded)

| Var | Secret? | Notes |
| --- | --- | --- |
| `SENTRY_AUTH_TOKEN` | **secret** | Set as an **EAS secret**, never committed. Uploads source maps during `eas build`; without it the build still succeeds (unminified traces). |
| `SENTRY_ORG`, `SENTRY_PROJECT` | public | Identify where maps go. |

---

## `@emberly/sync` (worker)

All secrets. They live only in the worker's gitignored `.env` locally and Coolify's secret
store in production — never in the web env, never in the iOS apps, never committed.

### ResMan (property-management source)

| Var | Required? | Notes |
| --- | --- | --- |
| `RESMAN_SYNC_USERNAME` | yes | ResMan sync account username. |
| `RESMAN_SYNC_PASSWORD` | yes | The **rotated** password — never the old leaked value. |
| `RESMAN_PROPERTY_ID` | yes | Property to filter reports on (`PropertyOrGroupIDs`). |
| `RESMAN_ACCOUNT_ID` | no | Defaults to the Multi-South preset (`1659`). |
| `RESMAN_SUBDOMAIN` | no | Defaults to `multisouth`. |

### MLGW (utility-billing source — optional)

| Var | Notes |
| --- | --- |
| `MLGW_SYNC_USERNAME`, `MLGW_SYNC_PASSWORD` | MLGW credentials. |
| `MLGW_SYNC_RESTART_ATTEMPTS`, `MLGW_BILL_PAGE_SIZE`, `XMS_MLGW_DEBUG_LOGS` | Tuning/debug. |

### Supabase

| Var | Notes |
| --- | --- |
| `SUPABASE_URL` | Project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret** — bypasses RLS, server-side only. |

## Variables previously documented only in per-app templates

Carried here when the per-app `.env*.example` files were replaced by the single
generated `.env.example` at the repo root. This table is now the source of prose —
`bun run env:build --examples` reads it, so a variable documented here shows up in
the generated template.

| Var | Secret? | Notes |
| --- | --- | --- |
| `ADMIN_BREAKGLASS_KEY` | **secret** | Emergency break-glass only. Leave BLANK to disable (off by default → the only way in is a ResMan login). When set, it grants super_admin via the login form's "emergency key" field or the x-admin-key header. Rotate/unset after use. |
| `ADMIN_SESSION_SECRET` | **secret** | Admin/session auth. The admin dashboard logs in with ResMan STAFF credentials (validated against the ResMan admin portal); a local admin_users row is created on first login. There is no shared admin key. |
| `ASC_REVIEW_FIRST_NAME` | public | --- App Store Connect metadata (eas metadata:push) ------------------------- Only needed when pushing store metadata, never by the app itself. ASC_DEMO_* must be a DEDICATED review account, never a real staff member's ResMan login — App Review shares these credentials internally. |
| `ASC_SUPPORT_URL` | public | Must RESOLVE — Apple rejects a dead privacy-policy link, and neither page exists yet (apps/web has no /privacy or /support route). |
| `EXPO_PUBLIC_API_PORT` | public | --- API --- |
| `EXPO_PUBLIC_BASE_URL` | public | --- API --- |
| `EXPO_PUBLIC_DEV_TOKEN` | public | Dev-only bearer token to skip sign-in during local development. Leave unset in builds. |
| `EXPO_PUBLIC_POSTHOG_HOST` | public | Defaults to https://us.i.posthog.com when unset. Use https://eu.i.posthog.com for EU. |
| `EXPO_PUBLIC_POSTHOG_KEY` | public | --- PostHog (product analytics) --- Leave EXPO_PUBLIC_POSTHOG_KEY unset to disable analytics (capture() becomes a no-op). |
| `EXPO_PUBLIC_SENTRY_DSN` | public | --- Sentry (crash + error reporting) --- This app reports to its OWN Sentry project (separate from the web + resident apps). Leave EXPO_PUBLIC_SENTRY_DSN unset to disable Sentry entirely (init is skipped). |
| `EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | public | Performance tracing sample rate 0..1 (default 0.2 when a DSN is set). |
| `LANGBLY_API_KEY` | **secret** | --- Langbly (translation pre-cache) --- Translates work-order prose server-side on the cron sync so techs' phones don't. OPTIONAL: with no key, sync:translate-work-orders logs "skipping" and no-ops, so the pipeline is safe to run without it. Free tier is 500k chars/month; this property uses ~60k/month. |
| `LANGBLY_API_URL` | public | Optional — defaults to https://api.langbly.com. Any Google Translate v2 compatible endpoint works here. |
| `RESIDENT_ALLOWED_PORTAL_STATUSES` | public | Resident-app login gate. Residents may sign in only when their ResMan portal status is Current, Pending Renewal, or Under Eviction (always allowed). This ADDS extra statuses on top of those — comma-separated, case-insensitive — for testing with non-active accounts (e.g. "Approved,Future"). Leave blank in production. In development, "Approved" is already allowed without this. |
| `RESMAN_PORTAL_ORIGIN` | public | ResMan portal adapter. Do not configure or store ResMan API credentials. |
| `SCANNER_SECRET_PEPPER` | **secret** | Scanner authentication. Scanner keys live ONLY in the scanner_devices table — create/rotate them from the admin Scanners page (the key is shown once). There are no env-configured scanner keys. This pepper is the HMAC secret the stored secret_hash is derived with; changing it invalidates every existing key. |
| `UTILITIES_MONTHLY_SPEND_GOAL` | public | --- Admin Utilities dashboard --- Optional monthly spend goal (USD) — draws the goal line on /admin/utilities. Leave unset to hide the line, matching XMS. |
