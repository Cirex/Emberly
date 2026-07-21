# Environment Variables

Every variable each deployable reads, where it goes, and which are secret. Each app ships a
committed template — copy it and fill in what you need:

| App | Local template | Production template |
| --- | --- | --- |
| `@emberly/web` | `apps/web/.env.example` → `.env.local` | `apps/web/.env.production.example` → `.env.production` |
| `@emberly/resident` | `apps/resident/.env.example` → `.env.local` | `apps/resident/.env.production.example` → `.env.production` |
| `@emberly/security` | `apps/security/.env.example` → `.env.local` | `apps/security/.env.production.example` → `.env.production` |
| `@emberly/maintenance` | `apps/maintenance/.env.example` → `.env.local` | `apps/maintenance/.env.production.example` → `.env.production` |
| `@emberly/sync` | `supabase/sync/.env.example` → `.env` | (Coolify secret store) |

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
