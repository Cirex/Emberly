# Emberly

**Emberly is a multi-tenant apartment access and property-management platform.** It gives
a property's staff, residents, guards, and maintenance techs one connected system for
resident access, guest passes, entry auditing, work orders, and the property map — all
backed by a single source of truth synced from the property-management system (ResMan) and
the utility-billing system (MLGW).

It is a Bun + Turborepo monorepo containing one web application (admin portal, resident
web, and the shared backend API), three native iOS apps, a shared domain package, and a
background sync worker.

> 📖 **Full documentation lives in the [GitHub Wiki](../../wiki).** This README is the
> orientation; the wiki has the architecture, the deployment runbook, environment-variable
> reference, and how to connect an AI assistant to the MCP server. The wiki is authored in
> [`docs/`](./docs) — see [docs/README.md](./docs/README.md) for how it's published.

---

## What Emberly does

- **Resident access, kept fresh.** Resident and lease data flows continuously from ResMan
  into Supabase, so every app sees the same current view of who lives where, lease status,
  and delinquency — without staff re-keying anything.
- **Guest passes.** Residents create time-boxed QR guest passes in the resident app or on
  the web; guards scan them at the gate; every scan is verified server-side and audited.
- **Entry auditing.** Every scan and access event is logged and visible to staff, with
  exception alerts for anything out of policy.
- **The property map.** A live map of the property — units, zones, and UniFi Protect
  camera snapshots — shared by the guard and maintenance apps.
- **Work orders and make-ready.** Maintenance techs manage work orders, a make-ready board,
  and a proximity-aware "My Day" route across the property.
- **A staff API + read-only MCP.** A private REST API exposes the synced ResMan/MLGW data
  to the mobile apps, and a read-only [MCP server](../../wiki/MCP-Server-Setup) lets staff
  query the same data from the AI assistant of their choice.

---

## The applications

| App | Package | Platform | Purpose |
| --- | --- | --- | --- |
| **Web** | `@emberly/web` | Next.js on Coolify | Staff admin portal, resident web, **and the backend API** every mobile app calls. |
| **Resident** | `@emberly/mobile` | Expo / iOS (EAS) | Residents sign in and manage their guest passes ("My Pass"). |
| **Security** | `@emberly/security` | Expo / iPad + iPhone (EAS) | Guard app: tenant directory, property map with camera snapshots, QR scanner, guest passes. |
| **Maintenance** | `@emberly/maintenance` | Expo / iOS (EAS) | Maintenance app: work orders, make-ready board, property map, "My Day" routing. |
| **Sync worker** | `@emberly/sync` | Coolify cron worker | Continuously mirrors ResMan + MLGW data into Supabase. |
| **Core** | `@emberly/core` | Shared package | Framework-free domain logic, constants, and contracts shared by every app. |

### Web — `@emberly/web`

The web app is three things at once:

- **Admin portal** (`/admin`) — resident access health, guest-pass controls, scanner-device
  management, entry audit logs, resident detail pages, exception alerts, the property-map
  camera view, and **Access Tokens** (mint per-staff API and MCP tokens).
- **Resident web** (`/guest-pass`) — public guest-pass viewing.
- **Backend API** (`/api/*`) — the private REST API over the synced data (`/api/resman`,
  `/api/mlgw`), scanner + pass verification (`/api/scanner`, `/api/verify-pass`), the
  resident and map endpoints, the read-only MCP server (`/api/mcp`), cron endpoints, and a
  dependency-free health check (`/api/health`). **All three mobile apps talk only to this
  API** — they never reach Supabase directly.

### Resident — `@emberly/mobile`

The resident iOS app ("Emberly Apartments"). Residents sign in with their ResMan portal
credentials (gated to active lease statuses) and create, view, and manage time-boxed QR
guest passes.

### Security — `@emberly/security`

The guard app, iPad-primary. Four sections: a **tenant directory**, the **property map**
with live UniFi Protect camera snapshots, a QR **scanner** (react-native-vision-camera) that
verifies passes and access at the gate, and **guest passes**. The device authenticates with
a per-device scanner key entered once and stored in the Keychain — there is no shared
credential.

### Maintenance — `@emberly/maintenance`

The maintenance-tech app. **Work orders** (open board, closed history, hot-spots, analytics),
a **make-ready board**, the **property map**, and **My Day** — a weighted, proximity-aware
route the tech follows across the property.

### Sync worker — `@emberly/sync`

A long-lived Coolify cron worker that scrapes ResMan (units, availability, unit details,
lease details, delinquency, work orders) and MLGW (utility bills and payments) into the
shared Supabase project. Its credentials live only in the worker's secret store — never in
the web env or the iOS apps.

---

## Getting started

```bash
brew install bun          # or: curl -fsSL https://bun.sh/install | bash
bun install               # honors the committed bun.lock

bun run typecheck
bun run lint
bun run test
bun run web:build
```

Run an app locally:

```bash
bun run web:dev                                   # Next.js admin + resident web + API
bun run mobile:start                              # Resident app (Expo)
bun run --filter '@emberly/security' start        # Security app (Expo)
bun run --filter '@emberly/maintenance' start     # Maintenance app (Expo)
```

Copy each app's `.env.example` to `.env.local` and fill in what you need — every service
(Supabase, Sentry, PostHog, Resend, UniFi) is inert until its keys are set, so the apps boot
and run with an empty env. See the wiki's [Environment
Variables](../../wiki/Environment-Variables) page for the full reference.

---

## Repository layout

```
apps/
  web/          @emberly/web          Next.js admin + resident web + backend API (Coolify)
  mobile/       @emberly/mobile       Resident iOS app (EAS)
  security/     @emberly/security     Guard iOS app (EAS)
  maintenance/  @emberly/maintenance  Maintenance iOS app (EAS)
packages/
  core/         @emberly/core         Framework-free domain logic, constants, contracts
supabase/
  sync/         @emberly/sync         ResMan + MLGW sync worker (Coolify cron worker)
  (migrations, schema, RLS/database tests)
docs/           GitHub Wiki source (Home, Architecture, Deployment, MCP, env reference)
```

The stack is Bun (runtime + package manager), Turborepo, TypeScript, Next.js, Expo / React
Native, Supabase (Postgres + RLS), Zustand, Zod, i18next, NativeWind / Tailwind, Sentry,
PostHog, and Resend.

---

## Contributing

See [`AGENTS.md`](./AGENTS.md) for the required workflow, architecture boundaries, import
rules, and stack conventions. In short: branch off `main`, keep changes small and inside
their boundary, validate every external input with Zod, never commit secrets or `.env*`
files, and keep `.env.example` and the docs current.

## Learn more

- **[Architecture](../../wiki/Architecture)** — how the apps, sync worker, and Supabase fit together
- **[Deployment](../../wiki/Deployment)** — the end-to-end production runbook
- **[Environment Variables](../../wiki/Environment-Variables)** — every variable each app reads
- **[MCP Server Setup](../../wiki/MCP-Server-Setup)** — connect an AI assistant to the staff MCP server
