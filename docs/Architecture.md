# Architecture

Emberly is a Bun + Turborepo monorepo. One web app serves the admin portal, the resident
web, and the backend API; three native iOS apps talk to that API; a background worker keeps
the data fresh; and a shared package holds the framework-free domain logic.

## The big picture

```
        ResMan portal              MLGW utility billing
        (property mgmt)            (utility bills)
              │                          │
              └───────────┬──────────────┘
                          ▼
                 @emberly/sync worker           ← long-lived Coolify cron worker
                 (scrapes both sources)
                          │
                          ▼
                 ┌──────────────────┐
                 │     Supabase     │            ← Postgres + RLS, the shared store
                 │  (resman_*,      │
                 │   mlgw_* mirror) │
                 └──────────────────┘
                          ▲
                          │  service role (server-only)
                          │
                 ┌──────────────────┐
                 │  @emberly/web    │            ← Next.js on Coolify
                 │  admin · resident │
                 │  web · REST API   │
                 │  · MCP server     │
                 └──────────────────┘
                    ▲      ▲      ▲
        HTTPS /api  │      │      │  HTTPS /api
          ┌─────────┘      │      └─────────┐
          │                │                │
   @emberly/mobile  @emberly/security  @emberly/maintenance
    (resident iOS)   (guard iPad/iOS)   (maintenance iOS)
```

**Key rule:** the mobile apps never touch Supabase directly. They authenticate to and read
from the web app's private REST API. Only the web app and the sync worker hold the Supabase
service-role key.

## Where the data comes from

- **ResMan** is the upstream authority for residents, leases, units, availability,
  delinquency, and work orders. Emberly never stores raw ResMan sessions; it persists only
  Emberly-owned operational state (access freshness, guest-pass status, scanner metadata,
  entry logs, exception alerts, admin actions).
- **MLGW** is the upstream authority for utility bills and payments.
- The **sync worker** (`@emberly/sync`) scrapes both on a schedule into the `resman_*` and
  `mlgw_*` mirror tables in Supabase. Individual runners exist per dataset (units, available
  units, unit details/info, lease details, delinquency, work orders, MLGW bills, MLGW
  payments).

## The applications

### `@emberly/web` — Next.js (App Router)

Deployed on Coolify. Three responsibilities:

- **Admin portal** (`app/admin`) — staff sign in with their ResMan **staff** credentials
  (an `admin_users` row is created on first login; there is no shared admin password). Covers
  resident access health, guest-pass controls, scanner-device management, entry audit logs,
  resident detail pages, exception alerts, the property-map camera view, and **Access
  Tokens** for minting per-staff API and MCP bearer tokens.
- **Resident web** (`app/guest-pass`) — public guest-pass viewing.
- **Backend API** (`app/api`) — the private read-only REST API over the mirror data
  (`/api/resman/*`, `/api/mlgw/*`), scanner + pass verification (`/api/scanner`,
  `/api/verify-pass`), resident and map endpoints, the read-only **MCP server**
  (`/api/mcp`), cron endpoints (`/api/cron/*`), and a dependency-free health check
  (`/api/health`).

Route handlers authenticate, authorize, validate with Zod, delegate to services, and return
intentional status codes. The REST API and MCP server are gated per-caller by a rotatable API
token (`eapi_…` / `emcp_…`) or a per-scanner credential — there is no shared key, and access
fails closed.

### `@emberly/mobile` — Resident (Expo / React Native)

Residents sign in with their ResMan portal credentials (gated to active lease statuses) and
create, view, and manage time-boxed QR guest passes.

### `@emberly/security` — Security / guard (Expo / React Native)

iPad-primary guard app with four sections: tenant directory, property map with live UniFi
Protect camera snapshots, a QR **scanner** (react-native-vision-camera) that verifies passes
and access at the gate, and guest passes. The device authenticates with a per-device scanner
key entered once and stored in the Keychain.

### `@emberly/maintenance` — Maintenance (Expo / React Native)

Work orders (open board, closed history, hot-spots, analytics), a make-ready board, the
property map, and **My Day** — a weighted, proximity-aware route across the property.

### `@emberly/sync` — Sync worker

See "Where the data comes from" above. Runs as a Coolify cron worker; its ResMan/MLGW
credentials live only in the worker's secret store.

### `@emberly/core` — Shared package

Framework-free domain models, constants, Zod contracts, and pure logic shared across apps.
It imports no app code, React, Expo, Next.js, or Supabase — apps depend on `core`, never the
reverse.

## Import boundaries

```
apps/*        ->  packages/core
packages/core ->  (nothing app-, framework-, or provider-specific)
```

Apps may import shared packages; packages must not import app code. See
[`AGENTS.md`](https://github.com/Cirex/Emberly/blob/main/AGENTS.md) for the full architecture,
state-management, validation, and testing rules.

## External services

| Service | Role | Where its keys live |
| --- | --- | --- |
| **Supabase** | Shared Postgres + RLS store | Web + sync worker (service role); mobile apps never hold it |
| **ResMan** | Upstream resident/lease/work-order data | Sync worker (scrape creds); web (portal adapter, no API creds) |
| **MLGW** | Upstream utility bills/payments | Sync worker |
| **Resend** | Guest-pass and notification email | Web (server-only) |
| **UniFi Protect** | Property-map camera snapshots | Web (server-side proxy; key never ships to the guard app) |
| **Sentry** | Crash/error reporting | One project per app; DSNs per app |
| **PostHog** | Product analytics | Mobile apps (client key) |

All observability and integration services are **inert until configured** — every app boots
and runs with them unset.
