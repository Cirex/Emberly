# Web API

> **Generated from the route handlers by `bun run docs:api`. Do not edit by hand —
> change the route's docblock and regenerate.** Each entry's prose is the docblock
> above that handler, so it lives next to the code and is updated in the same edit.

104 routes, 125 handlers.

## Conventions

**Success payloads are wrapped.** Most routes return `{ data: … }` rather than a bare
array or object, so a response can grow a sibling field (`meta`, `note`) without
breaking a client that destructures `data`.

**Errors are `{ error: string }`** with a non-2xx status. The message is meant for a
developer, not an end user — it is not localized and should not be shown verbatim.

**Auth is per-route, not per-prefix.** The guard column below is the function the
handler actually calls. Where a guard takes a capability string, that capability is
shown — a token without it gets 403 even though it authenticated fine.

| status | meaning |
| --- | --- |
| 200 | success |
| 202 | accepted — notification-only JSON-RPC, no body |
| 400 | malformed request: bad JSON, missing or invalid parameter |
| 401 | no credential, or one that did not verify |
| 403 | authenticated, but not permitted this capability or resource |
| 404 | no such row, or a route that hides existence deliberately |
| 409 | conflict with current state |
| 429 | rate limited |
| 500 | unhandled server error — the detail is logged, not returned |

## Contents

- [`/api/resman`](#apiresman) — 46 routes
- [`/api/admin`](#apiadmin) — 36 routes
- [`/api/mlgw`](#apimlgw) — 6 routes
- [`/api/resident`](#apiresident) — 5 routes
- [`/api/auth`](#apiauth) — 4 routes
- [`/api/cron`](#apicron) — 2 routes
- [`/api/entry-logs`](#apientrylogs) — 1 route
- [`/api/health`](#apihealth) — 1 route
- [`/api/mcp`](#apimcp) — 1 route
- [`/api/verify-pass`](#apiverifypass) — 1 route
- [`/api/scanner`](#apiscanner) — 1 route

## /api/resman

The staff API. Bearer-token routes consumed by the maintenance, security and manager apps.

### `GET /api/resman/buildings`

- **Auth** — ResMan API key (via `createListRoute`)
- **Source** — [`apps/web/app/api/resman/buildings/route.ts`](../apps/web/app/api/resman/buildings/route.ts)

### `GET /api/resman/buildings/:id`

- **Auth** — ResMan API key (via `createDetailRoute`)
- **Source** — [`apps/web/app/api/resman/buildings/[id]/route.ts`](../apps/web/app/api/resman/buildings/[id]/route.ts)

### `GET /api/resman/floorplans`

- **Auth** — ResMan API key (via `createListRoute`)
- **Source** — [`apps/web/app/api/resman/floorplans/route.ts`](../apps/web/app/api/resman/floorplans/route.ts)

### `GET /api/resman/floorplans/:id`

- **Auth** — ResMan API key (via `createDetailRoute`)
- **Source** — [`apps/web/app/api/resman/floorplans/[id]/route.ts`](../apps/web/app/api/resman/floorplans/[id]/route.ts)

### `GET /api/resman/leases`

- **Auth** — ResMan API key (via `createListRoute`)
- **Source** — [`apps/web/app/api/resman/leases/route.ts`](../apps/web/app/api/resman/leases/route.ts)

### `GET /api/resman/leases/:id`

- **Auth** — ResMan API key (via `createDetailRoute`)
- **Source** — [`apps/web/app/api/resman/leases/[id]/route.ts`](../apps/web/app/api/resman/leases/[id]/route.ts)

### `GET /api/resman/manager/delinquency`

GET /api/resman/manager/delinquency — the delinquency board feed: units
that owe money or carry a delinquency note, plus the live action timeline
(calls, notices, promises, filings) for those units, newest first. The
phone stitches both into the board. Staff-token only.

- **Auth** — staff bearer token, capability `manager:delinquency`
- **Returns**
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/manager/delinquency/route.ts`](../apps/web/app/api/resman/manager/delinquency/route.ts)

### `POST /api/resman/manager/delinquency-actions`

- **Auth** — staff bearer token, capability `manager:delinquency`
- **Returns**
  - `201` → `{ data }`
  - `400` → `{ error }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/resman/manager/delinquency-actions/route.ts`](../apps/web/app/api/resman/manager/delinquency-actions/route.ts)

### `DELETE /api/resman/manager/delinquency-actions/:id`

- **Auth** — staff bearer token, capability `manager:delinquency`
- **Returns**
  - `404` → `{ error }`
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/manager/delinquency-actions/[id]/route.ts`](../apps/web/app/api/resman/manager/delinquency-actions/[id]/route.ts)

### `GET /api/resman/manager/insurance`

GET /api/resman/manager/insurance — the insurance-compliance board feed:
one policy row per CURRENT lease (best policy by latest end_date; all-null
policy fields = never filed), plus the Emberly follow-up trail (proof
requests, second notices, verifications), newest first. The phone derives
covered/expiring/lapsed from the end dates on device — compliance is a date
comparison, not a server verdict. Policy numbers are masked server-side to
their last four characters. Staff-token only.

- **Auth** — staff bearer token, capability `manager:insurance`
- **Returns**
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/manager/insurance/route.ts`](../apps/web/app/api/resman/manager/insurance/route.ts)

### `POST /api/resman/manager/insurance-actions`

- **Auth** — staff bearer token, capability `manager:insurance`
- **Returns**
  - `201` → `{ data }`
  - `400` → `{ error }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/resman/manager/insurance-actions/route.ts`](../apps/web/app/api/resman/manager/insurance-actions/route.ts)

### `DELETE /api/resman/manager/insurance-actions/:id`

- **Auth** — staff bearer token, capability `manager:insurance`
- **Returns**
  - `404` → `{ error }`
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/manager/insurance-actions/[id]/route.ts`](../apps/web/app/api/resman/manager/insurance-actions/[id]/route.ts)

### `GET /api/resman/manager/lease-notes`

The shared staff notes thread on a lease (manager app, pipeline detail
sheet).

GET  ?lease=<resman_lease_id> — the lease's thread, oldest first.
POST { resmanLeaseId, body, unitNumber? } — append one note; attribution
(name + role + admin id) comes from the token, like
delinquency-actions.

Rides on `manager:leases` on purpose: notes are part of the lease surface,
and a new capability would have signed every existing manager token out of
the thread (see app-role-capabilities on why PM rides on work-orders).

- **Auth** — staff bearer token, capability `manager:leases`
- **Returns**
  - `400` → `{ error }`
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/manager/lease-notes/route.ts`](../apps/web/app/api/resman/manager/lease-notes/route.ts)

### `POST /api/resman/manager/lease-notes`

- **Auth** — staff bearer token, capability `manager:leases`
- **Returns**
  - `201` → `{ data }`
  - `400` → `{ error }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/resman/manager/lease-notes/route.ts`](../apps/web/app/api/resman/manager/lease-notes/route.ts)

### `GET /api/resman/manager/leases`

GET /api/resman/manager/leases — leases from the last 24 months (by
application, start, or move-in date) plus anything still current, in one
chunky payload. The manager app derives Pipeline / Expirations / Forecast
boards and agent scorecards on device. Staff-token only: scanners are gate
devices and the leasing pipeline is none of their business.

- **Auth** — staff bearer token, capability `manager:leases`
- **Returns**
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/manager/leases/route.ts`](../apps/web/app/api/resman/manager/leases/route.ts)

### `GET /api/resman/manager/ledger`

GET /api/resman/manager/ledger?leaseId=… — one lease's transactions from
the resman_transactions mirror, newest first, capped at 500. The drill-in
behind a ledger-summary row. Staff-token only.

- **Auth** — staff bearer token, capability `manager:ledger`
- **Returns**
  - `400` → `{ error }`
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/manager/ledger/route.ts`](../apps/web/app/api/resman/manager/ledger/route.ts)

### `GET /api/resman/manager/ledger-summary`

GET /api/resman/manager/ledger-summary — one row per lease aggregated from
the resman_transactions mirror: billed/collected totals, last payment date,
first late month (month-end running balance heuristic), and net
concession/write-off values. No raw-SQL RPC exists, so the aggregation runs
in JS over a paged, column-slim select capped at 50k rows. Staff-token only.

- **Auth** — staff bearer token, capability `manager:ledger`
- **Returns**
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/manager/ledger-summary/route.ts`](../apps/web/app/api/resman/manager/ledger-summary/route.ts)

### `GET /api/resman/manager/mlgw`

GET /api/resman/manager/mlgw — the utility surface in one chunky payload:
accounts with current dues, each account's current bill with charge totals,
a 12-month spend series aggregated by bill month, and the exception-review
checklist state. Staff-token only.

- **Auth** — staff bearer token, capability `manager:mlgw`
- **Returns**
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/manager/mlgw/route.ts`](../apps/web/app/api/resman/manager/mlgw/route.ts)

### `POST /api/resman/manager/mlgw-reviews`

- **Auth** — staff bearer token, capability `manager:mlgw`
- **Returns**
  - `400` → `{ error }`
  - `500` → `{ error, data }`
- **Source** — [`apps/web/app/api/resman/manager/mlgw-reviews/route.ts`](../apps/web/app/api/resman/manager/mlgw-reviews/route.ts)

### `GET /api/resman/manager/people`

GET /api/resman/manager/people — the SEARCH INDEX: one lightweight row per
resident (name, unit, phones, email, plates) so the manager app can match
name / unit / phone / plate entirely on device, offline, from cache.

FREE OF THE SENSITIVE TIER BY CONSTRUCTION: birthdate, driver's licence and
income are not in this payload and never will be — it is persisted to the
phone's disk. The profile route is the only place those fields can be
requested, and only behind `?includePii=1` with an audit-log row.

It is NOT free of personal data: a name, unit, phone, email and plate per
resident is exactly that, which is why the app purges this cache on sign-out
(apps/manager/lib/session-data.ts).

Staff-token only: scanners are gate devices, and scoped field-device roles
(maintenance, security) have no business holding the resident roster.

- **Auth** — staff bearer token, capability `manager:people`
- **Returns**
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/manager/people/route.ts`](../apps/web/app/api/resman/manager/people/route.ts)

### `GET /api/resman/manager/people/:id`

GET /api/resman/manager/people/[id] — the full tenant profile for one
`resman_person_lease_id`: the resident, their lease facts, household,
vehicles, insurance, employment, emergency contacts, addresses, and the
unit's ten most recent work orders.

PII GATING (the design's build note, enforced): birthdate, driversLicense,
driversLicenseState, monthlyIncome and otherIncome are ABSENT from the
default payload. `?includePii=1` returns them and writes an admin_audit_logs
row recording who asked, for whom, and which field — `?field=birthdate`
names the field the manager tapped. The derived `rentToIncomeRatio` is in
every response: it is the affordability answer without the salary.

Staff-token only.

- **Auth** — staff bearer token, capability `manager:people`
- **Returns**
  - `404` → `{ error }`
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/manager/people/[id]/route.ts`](../apps/web/app/api/resman/manager/people/[id]/route.ts)

### `GET /api/resman/manager/renewal-offers`

- **Auth** — staff bearer token, capability `manager:renewals`
- **Returns**
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/manager/renewal-offers/route.ts`](../apps/web/app/api/resman/manager/renewal-offers/route.ts)

### `POST /api/resman/manager/renewal-offers`

- **Auth** — staff bearer token, capability `manager:renewals`
- **Returns**
  - `201` → `{ data }`
  - `400` → `{ error }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/resman/manager/renewal-offers/route.ts`](../apps/web/app/api/resman/manager/renewal-offers/route.ts)

### `PATCH /api/resman/manager/renewal-offers/:id`

- **Auth** — staff bearer token, capability `manager:renewals`
- **Returns**
  - `400` → `{ error }`
  - `404` → `{ error }`
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/manager/renewal-offers/[id]/route.ts`](../apps/web/app/api/resman/manager/renewal-offers/[id]/route.ts)

### `GET /api/resman/manager/reports`

GET /api/resman/manager/reports — the owner-report archive index for the
manager app: `{ data: { reports: [{ period, generatedAt, summary }] } }`,
newest first, capped at 24. Each summary is parsed server-side from the
period's frozen-figures JSON so the phone's report card and PAST REPORTS
band render without any extra fetches. Staff-token only — scanners are gate
devices and the owner packet is none of their business (same rule as
/manager/snapshots).

- **Auth** — staff bearer token, capability `manager:reports`
- **Returns**
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/manager/reports/route.ts`](../apps/web/app/api/resman/manager/reports/route.ts)

### `GET /api/resman/manager/reports/:period`

- **Auth** — staff bearer token, capability `manager:reports`
- **Returns**
  - `400` → `{ error }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/resman/manager/reports/[period]/route.ts`](../apps/web/app/api/resman/manager/reports/[period]/route.ts)

### `GET /api/resman/manager/snapshots`

GET /api/resman/manager/snapshots?months=12 — the daily property_snapshots
window (default 12 months, capped at 24), oldest first, for the manager
app's Trends charts. The phone renders the series directly; nulls mean the
series hadn't begun yet (the honest-backfill rule). Staff-token only:
scanners are gate devices and property KPIs are none of their business.

- **Auth** — staff bearer token, capability `manager:snapshots`
- **Returns**
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/manager/snapshots/route.ts`](../apps/web/app/api/resman/manager/snapshots/route.ts)

### `GET /api/resman/metrics`

- **Auth** — ResMan API key
- **Returns**
  - `403` → `{ error }`
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/metrics/route.ts`](../apps/web/app/api/resman/metrics/route.ts)

### `GET /api/resman/pm-tasks`

- **Auth** — staff bearer token, capability `work-orders`
- **Returns**
  - `400` → `{ error }`
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/pm-tasks/route.ts`](../apps/web/app/api/resman/pm-tasks/route.ts)

### `POST /api/resman/pm-tasks/:id`

- **Auth** — staff bearer token, capability `work-orders`
- **Returns**
  - `400` → `{ error }`
  - `404` → `{ error }`
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/pm-tasks/[id]/route.ts`](../apps/web/app/api/resman/pm-tasks/[id]/route.ts)

### `GET /api/resman/properties`

- **Auth** — ResMan API key (via `createListRoute`)
- **Source** — [`apps/web/app/api/resman/properties/route.ts`](../apps/web/app/api/resman/properties/route.ts)

### `GET /api/resman/properties/:id`

- **Auth** — ResMan API key (via `createDetailRoute`)
- **Source** — [`apps/web/app/api/resman/properties/[id]/route.ts`](../apps/web/app/api/resman/properties/[id]/route.ts)

### `GET /api/resman/residents`

- **Auth** — ResMan API key (via `createListRoute`)
- **Source** — [`apps/web/app/api/resman/residents/route.ts`](../apps/web/app/api/resman/residents/route.ts)

### `GET /api/resman/residents/:id`

- **Auth** — ResMan API key (via `createDetailRoute`)
- **Source** — [`apps/web/app/api/resman/residents/[id]/route.ts`](../apps/web/app/api/resman/residents/[id]/route.ts)

### `GET /api/resman/transactions`

- **Auth** — ResMan API key (via `createListRoute`)
- **Source** — [`apps/web/app/api/resman/transactions/route.ts`](../apps/web/app/api/resman/transactions/route.ts)

### `GET /api/resman/transactions/:id`

- **Auth** — ResMan API key (via `createDetailRoute`)
- **Source** — [`apps/web/app/api/resman/transactions/[id]/route.ts`](../apps/web/app/api/resman/transactions/[id]/route.ts)

### `GET /api/resman/units`

- **Auth** — ResMan API key (via `createListRoute`)
- **Source** — [`apps/web/app/api/resman/units/route.ts`](../apps/web/app/api/resman/units/route.ts)

### `GET /api/resman/units/:id`

- **Auth** — ResMan API key (via `createDetailRoute`)
- **Source** — [`apps/web/app/api/resman/units/[id]/route.ts`](../apps/web/app/api/resman/units/[id]/route.ts)

### `GET /api/resman/units/:id/detail`

The per-unit facts the guard app's tenant detail pane needs and the generic
unit resource cannot express: vehicles live two joins away, and the last entry
lives in a first-party table the ResMan mirror knows nothing about.

Vehicles hang off the *lease*: unit.current_lease_id → resman_residents
(person-leases on that lease) → resman_lease_vehicles. A vacant unit, or one
whose lease has no residents synced, correctly yields none.

Last entry is matched on `entry_logs.unit_address`, which is what verify-pass
records at scan time. That is a denormalized string rather than a key, so the
match is deliberately conservative — see the comment at the query.

- **Auth** — ResMan API key
- **Returns**
  - `403` → `{ error }`
  - `404` → `{ error }`
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/units/[id]/detail/route.ts`](../apps/web/app/api/resman/units/[id]/detail/route.ts)

### `GET /api/resman/units/details`

- **Auth** — ResMan API key
- **Returns**
  - `403` → `{ error }`
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/units/details/route.ts`](../apps/web/app/api/resman/units/details/route.ts)

### `GET /api/resman/units/guest-bans`

The unit numbers where guest visits are currently disabled — the union of:
- guest_pass_unit_bans (the unit itself is suspended, no enrollment needed)
- guest_pass_bans joined through residents (someone at the unit is blocked)

This exists for the guard app's "No Guests" tenant filter: the units list is
a generic ResMan-mirror read, while ban state lives in first-party tables, so
the app fetches this small set once and filters client-side. Same audience
gating as the unit detail pane: scanners and back-office tokens may read it,
scoped field-device tokens may not.

- **Auth** — ResMan API key
- **Returns**
  - `403` → `{ error }`
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/units/guest-bans/route.ts`](../apps/web/app/api/resman/units/guest-bans/route.ts)

### `GET /api/resman/work-order-photos/:photoId`

- **Auth** — staff bearer token, capability `work-orders`
- **Returns**
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/resman/work-order-photos/[photoId]/route.ts`](../apps/web/app/api/resman/work-order-photos/[photoId]/route.ts)

### `DELETE /api/resman/work-order-photos/:photoId`

- **Auth** — staff bearer token, capability `work-orders`
- **Returns**
  - `500` → `{ error, ok }`
- **Source** — [`apps/web/app/api/resman/work-order-photos/[photoId]/route.ts`](../apps/web/app/api/resman/work-order-photos/[photoId]/route.ts)

### `GET /api/resman/work-orders`

- **Auth** — ResMan API key (via `createListRoute`)
- **Source** — [`apps/web/app/api/resman/work-orders/route.ts`](../apps/web/app/api/resman/work-orders/route.ts)

### `GET /api/resman/work-orders/:id`

- **Auth** — ResMan API key (via `createDetailRoute`)
- **Source** — [`apps/web/app/api/resman/work-orders/[id]/route.ts`](../apps/web/app/api/resman/work-orders/[id]/route.ts)

### `POST /api/resman/work-orders/:id/close`

POST /api/resman/work-orders/[id]/close — queue a work-order close for ResMan.

The OFFICE-SIDE / fallback write path. The maintenance app closes work
orders in ResMan DIRECTLY from the device under the technician's own
session (so ResMan's audit trail records the tech) and does not call this
route; it remains for office tooling and any client without a device-held
ResMan session. ResMan is the system of record, and this route never
touches it inline: it validates the work order exists and appends a durable
row to `maintenance_work_order_edits`, which the sync worker's
flush-work-order-writes job replays against ResMan's edit form — Status
becomes "Completed" (the office's Close stays office work), the completion
date is stamped, and ResMan credits the ASSIGNED technician
(CompletedByPersonID follows AssignedToPersonID). When the caller did not
stamp a completion date, the flush uses this row's created_at — the moment
it was requested, not the moment the queue drained. Never write
resman_work_orders directly.

Staff-token only: a scanner is a gate device, not a maintenance tool.

- **Auth** — ResMan API key
- **Returns**
  - `403` → `{ error }`
  - `404` → `{ error }`
  - `500` → `{ ok, queued, error }`
- **Source** — [`apps/web/app/api/resman/work-orders/[id]/close/route.ts`](../apps/web/app/api/resman/work-orders/[id]/close/route.ts)

### `POST /api/resman/work-orders/:id/edit`

POST /api/resman/work-orders/[id]/edit — queue a work-order edit for ResMan.

The OFFICE-SIDE / fallback write path. The maintenance app writes to ResMan
DIRECTLY from the device under the technician's own session (so ResMan's
audit trail records the tech) and does not call this route; it remains for
office tooling and any client without a device-held ResMan session. ResMan
is the system of record, and this route never touches it inline: it
validates the work order exists and appends a durable row to
`maintenance_work_order_edits`, which the sync worker's
flush-work-order-writes job replays against ResMan's edit form (edits and
closes only — delete and cancel are refused by the writer). Never write
resman_work_orders directly.

Staff-token only: a scanner is a gate device, not a maintenance tool.

- **Auth** — ResMan API key
- **Returns**
  - `400` → `{ error }`
  - `403` → `{ error }`
  - `404` → `{ error }`
  - `500` → `{ ok, queued, error }`
- **Source** — [`apps/web/app/api/resman/work-orders/[id]/edit/route.ts`](../apps/web/app/api/resman/work-orders/[id]/edit/route.ts)

### `GET /api/resman/work-orders/:id/photos`

- **Auth** — staff bearer token, capability `work-orders`
- **Returns**
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/work-orders/[id]/photos/route.ts`](../apps/web/app/api/resman/work-orders/[id]/photos/route.ts)

### `POST /api/resman/work-orders/:id/photos`

- **Auth** — staff bearer token, capability `work-orders`
- **Returns**
  - `201` → `{ error, data }`
  - `400` → `{ error }`
  - `404` → `{ error }`
  - `413` → `{ error }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/resman/work-orders/[id]/photos/route.ts`](../apps/web/app/api/resman/work-orders/[id]/photos/route.ts)

### `GET /api/resman/work-orders/translations`

- **Auth** — ResMan API key
- **Returns**
  - `400` → `{ error }`
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/resman/work-orders/translations/route.ts`](../apps/web/app/api/resman/work-orders/translations/route.ts)

## /api/admin

Browser-facing routes behind the admin session cookie. These back the `/admin` dashboard.

### `GET /api/admin/admins`

Admin API for the admin_users directory.
GET /api/admin/admins — list admin users (role, status, last login)

Gated to super_admin: the roster reveals who holds which privileges, and this
endpoint backs the role-management surface. Role edits live at
/api/admin/admins/[id] (PATCH).

- **Auth** — admin session, capability `super_admin`
- **Returns**
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/admin/admins/route.ts`](../apps/web/app/api/admin/admins/route.ts)

### `PATCH /api/admin/admins/:id`

Admin API — change one admin user's role.
PATCH /api/admin/admins/{id}  body: { role }

Gated to super_admin (granting privileges must itself be privileged). Refuses
an unknown role and refuses to demote the last active super_admin (which would
lock everyone out of the super_admin-only surfaces, including this one).

- **Auth** — admin session, capability `super_admin`
- **Returns**
  - `400` → `{ error }`
  - `404` → `{ error }`
  - `409` → `{ error }`
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/admin/admins/[id]/route.ts`](../apps/web/app/api/admin/admins/[id]/route.ts)

### `GET /api/admin/alerts`

- **Auth** — admin session
- **Returns**
  - `400` → `{ error, details }`
  - `500` → `{ alerts, error }`
- **Source** — [`apps/web/app/api/admin/alerts/route.ts`](../apps/web/app/api/admin/alerts/route.ts)

### `POST /api/admin/alerts/:id/resolve`

- **Auth** — admin session, capability `property_manager`
- **Returns**
  - `200` → `{ alert }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/admin/alerts/[id]/resolve/route.ts`](../apps/web/app/api/admin/alerts/[id]/resolve/route.ts)

### `POST /api/admin/auth`

POST /api/admin/auth
Validates the admin key and sets a session cookie.

- **Auth** — ResMan staff credentials
- **Returns**
  - `400` → `{ error }`
- **Source** — [`apps/web/app/api/admin/auth/route.ts`](../apps/web/app/api/admin/auth/route.ts)

### `POST /api/admin/auth/app-token`

POST /api/admin/auth/app-token

Staff sign-in for the native apps (EmberlyMaintenance, EmberlyManager —
`app` in the body says which, defaulting to maintenance). Validates ResMan
credentials exactly like /api/admin/auth, but instead of a browser session
cookie it mints a per-user `eapi_` access token (kind='api_resman',
subject_type='admin_user') and returns the plaintext once. The app stores it
in the Keychain and sends it as `Authorization: Bearer` — already accepted by
every /api/resman/* route, and by /api/admin/* routes via
requireAdminOrScanner's token branch.

Each sign-in mints a fresh token (one per device — a tech's iPhone and iPad
each hold their own), so revoking one device never signs out another.
Revocation stays manual through the existing access-token tooling.

- **Auth** — ResMan staff credentials
- **Returns**
  - `200` → `{ ok, token, admin }`
  - `400` → `{ error }`
  - `401` → `{ error }`
  - `429` → `{ error }`
  - `502` → `{ error }`
- **Source** — [`apps/web/app/api/admin/auth/app-token/route.ts`](../apps/web/app/api/admin/auth/app-token/route.ts)

### `GET /api/admin/entry-logs`

- **Auth** — admin session
- **Returns**
  - `400` → `{ error, details }`
  - `500` → `{ (await), error }`
- **Source** — [`apps/web/app/api/admin/entry-logs/route.ts`](../apps/web/app/api/admin/entry-logs/route.ts)

### `GET /api/admin/entry-logs/:entryLogId/photos`

- **Auth** — admin session
- **Returns**
  - `200` → `{ photos }`
  - `400` → `{ error }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/admin/entry-logs/[entryLogId]/photos/route.ts`](../apps/web/app/api/admin/entry-logs/[entryLogId]/photos/route.ts)

### `GET /api/admin/guest-passes`

- **Auth** — admin session or scanner key
- **Returns**
  - `400` → `{ error, details }`
  - `500` → `{ (await), error }`
- **Source** — [`apps/web/app/api/admin/guest-passes/route.ts`](../apps/web/app/api/admin/guest-passes/route.ts)

### `PATCH /api/admin/guest-passes/:id`

- **Auth** — admin session or scanner key, capability `property_manager`
- **Returns**
  - `200` → `{ pass }`
  - `400` → `{ error, details }`
  - `404` → `{ error }`
  - `409` → `{ error }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/admin/guest-passes/[id]/route.ts`](../apps/web/app/api/admin/guest-passes/[id]/route.ts)

### `POST /api/admin/logout`

- **Auth** — **public by design** — clears the session cookie; requiring the session to drop it would strand a bad one
- **Source** — [`apps/web/app/api/admin/logout/route.ts`](../apps/web/app/api/admin/logout/route.ts)

### `GET /api/admin/map-annotation-photos/:photoId`

Streams the image bytes — <img> tags on the admin map point here.

- **Auth** — admin session or scanner key
- **Returns**
  - `200` → `{ error }`
- **Source** — [`apps/web/app/api/admin/map-annotation-photos/[photoId]/route.ts`](../apps/web/app/api/admin/map-annotation-photos/[photoId]/route.ts)

### `DELETE /api/admin/map-annotation-photos/:photoId`

- **Auth** — admin session or scanner key, capability `property_manager`
- **Returns**
  - `200` → `{ error, ok }`
- **Source** — [`apps/web/app/api/admin/map-annotation-photos/[photoId]/route.ts`](../apps/web/app/api/admin/map-annotation-photos/[photoId]/route.ts)

### `GET /api/admin/map-annotations`

Layered map annotations for the admin portal and the scanner iPads.
GET  /api/admin/map-annotations?layer=&since=  — list (tombstones with since)
POST /api/admin/map-annotations                — create

Admins see and write both layers; a scanner credential is confined to the
'security' layer no matter what it asks for. The external XCMS sync client
has its own routes under /api/map, pinned to 'staff'.

- **Auth** — admin session or scanner key
- **Returns**
  - `400` → `{ error }`
  - `403` → `{ error }`
  - `500` → `{ annotations, error }`
- **Source** — [`apps/web/app/api/admin/map-annotations/route.ts`](../apps/web/app/api/admin/map-annotations/route.ts)

### `POST /api/admin/map-annotations`

Layered map annotations for the admin portal and the scanner iPads.
GET  /api/admin/map-annotations?layer=&since=  — list (tombstones with since)
POST /api/admin/map-annotations                — create

Admins see and write both layers; a scanner credential is confined to the
'security' layer no matter what it asks for. The external XCMS sync client
has its own routes under /api/map, pinned to 'staff'.

- **Auth** — admin session or scanner key, capability `property_manager`
- **Returns**
  - `400` → `{ error, details }`
  - `500` → `{ annotation, error }`
- **Source** — [`apps/web/app/api/admin/map-annotations/route.ts`](../apps/web/app/api/admin/map-annotations/route.ts)

### `PATCH /api/admin/map-annotations/:annotationId`

Mutations on one layered annotation (admin portal + scanner iPads).
PATCH  — update; body carries expectedVersion (409 + currentVersion on conflict)
DELETE — soft delete; same versioning contract

A scanner credential can only reach security-layer rows; admins reach both.

- **Auth** — admin session or scanner key, capability `property_manager`
- **Returns**
  - `400` → `{ error, details }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/admin/map-annotations/[annotationId]/route.ts`](../apps/web/app/api/admin/map-annotations/[annotationId]/route.ts)

### `DELETE /api/admin/map-annotations/:annotationId`

Mutations on one layered annotation (admin portal + scanner iPads).
PATCH  — update; body carries expectedVersion (409 + currentVersion on conflict)
DELETE — soft delete; same versioning contract

A scanner credential can only reach security-layer rows; admins reach both.

- **Auth** — admin session or scanner key, capability `property_manager`
- **Returns**
  - `400` → `{ error, details }`
  - `500` → `{ ok, error }`
- **Source** — [`apps/web/app/api/admin/map-annotations/[annotationId]/route.ts`](../apps/web/app/api/admin/map-annotations/[annotationId]/route.ts)

### `GET /api/admin/map-annotations/:annotationId/photos`

- **Auth** — admin session or scanner key
- **Returns**
  - `200` → `{ photos }`
- **Source** — [`apps/web/app/api/admin/map-annotations/[annotationId]/photos/route.ts`](../apps/web/app/api/admin/map-annotations/[annotationId]/photos/route.ts)

### `POST /api/admin/map-annotations/:annotationId/photos`

- **Auth** — admin session or scanner key, capability `property_manager`
- **Returns**
  - `201` → `{ error, photo }`
  - `400` → `{ error }`
  - `413` → `{ error }`
- **Source** — [`apps/web/app/api/admin/map-annotations/[annotationId]/photos/route.ts`](../apps/web/app/api/admin/map-annotations/[annotationId]/photos/route.ts)

### `GET /api/admin/map-cameras`

Security-camera markers on the property map.
GET  — admins and scanner devices (the iPads render coverage cones)
POST — admins only; a scanner credential can look but never touch

- **Auth** — admin session or scanner key
- **Returns**
  - `500` → `{ cameras, error }`
- **Source** — [`apps/web/app/api/admin/map-cameras/route.ts`](../apps/web/app/api/admin/map-cameras/route.ts)

### `POST /api/admin/map-cameras`

Security-camera markers on the property map.
GET  — admins and scanner devices (the iPads render coverage cones)
POST — admins only; a scanner credential can look but never touch

- **Auth** — admin session, capability `property_manager`
- **Returns**
  - `400` → `{ error, details }`
  - `500` → `{ camera, error }`
  - `502` → `{ error }`
- **Source** — [`apps/web/app/api/admin/map-cameras/route.ts`](../apps/web/app/api/admin/map-cameras/route.ts)

### `PATCH /api/admin/map-cameras/:cameraId`

One camera marker: PATCH updates, DELETE removes. Admin session only —
scanner credentials are read-only for cameras by design.

- **Auth** — admin session, capability `property_manager`
- **Returns**
  - `400` → `{ error, details }`
  - `404` → `{ error }`
  - `500` → `{ camera, error }`
  - `502` → `{ error }`
- **Source** — [`apps/web/app/api/admin/map-cameras/[cameraId]/route.ts`](../apps/web/app/api/admin/map-cameras/[cameraId]/route.ts)

### `DELETE /api/admin/map-cameras/:cameraId`

One camera marker: PATCH updates, DELETE removes. Admin session only —
scanner credentials are read-only for cameras by design.

- **Auth** — admin session, capability `property_manager`
- **Returns**
  - `404` → `{ error }`
  - `500` → `{ ok, error }`
- **Source** — [`apps/web/app/api/admin/map-cameras/[cameraId]/route.ts`](../apps/web/app/api/admin/map-cameras/[cameraId]/route.ts)

### `GET /api/admin/map-cameras/:cameraId/snapshot`

Live snapshot for a paired map camera. Keyed by OUR camera id — the row
holds the UniFi console/camera pairing, so clients never handle UniFi ids.
Admins and scanner devices may view (the iPads show live feeds); the UniFi
cloud API key stays server-side.

GET /api/admin/map-cameras/{id}/snapshot → image/jpeg
?w=320 — downscaled variant for map thumbnails (UniFi always serves the
full frame, so shrinking here saves the iPads ~1.3 MB per refresh).

- **Auth** — admin session or scanner key
- **Returns**
  - `404` → `{ error }`
  - `409` → `{ error }`
  - `502` → `{ error }`
  - `503` → `{ error }`
- **Source** — [`apps/web/app/api/admin/map-cameras/[cameraId]/snapshot/route.ts`](../apps/web/app/api/admin/map-cameras/[cameraId]/snapshot/route.ts)

### `GET /api/admin/mcp-tokens`

Admin API for managing MCP staff bearer tokens (access_tokens, kind='mcp').
GET  /api/admin/mcp-tokens        — list MCP tokens (no secrets)
POST /api/admin/mcp-tokens        — mint one (returns plaintext once)
Gated by the admin session (requireAdmin).

- **Auth** — admin session
- **Returns**
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/admin/mcp-tokens/route.ts`](../apps/web/app/api/admin/mcp-tokens/route.ts)

### `POST /api/admin/mcp-tokens`

Admin API for managing MCP staff bearer tokens (access_tokens, kind='mcp').
GET  /api/admin/mcp-tokens        — list MCP tokens (no secrets)
POST /api/admin/mcp-tokens        — mint one (returns plaintext once)
Gated by the admin session (requireAdmin).

- **Auth** — admin session, capability `super_admin`
- **Returns**
  - `201` → `{ data }`
  - `400` → `{ error }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/admin/mcp-tokens/route.ts`](../apps/web/app/api/admin/mcp-tokens/route.ts)

### `DELETE /api/admin/mcp-tokens/:id`

Admin API — revoke a single MCP staff token.
DELETE /api/admin/mcp-tokens/{id}  — mark active=false, revoked_at=now
Gated by the admin session (requireAdmin). Revocation is immediate: the next
request carrying that token fails auth.

- **Auth** — admin session, capability `super_admin`
- **Returns**
  - `400` → `{ error }`
  - `404` → `{ error }`
  - `500` → `{ ok, error }`
- **Source** — [`apps/web/app/api/admin/mcp-tokens/[id]/route.ts`](../apps/web/app/api/admin/mcp-tokens/[id]/route.ts)

### `GET /api/admin/pm-templates`

Admin API for preventive-maintenance templates.
GET  /api/admin/pm-templates — templates with round stats + header summary
POST /api/admin/pm-templates — create a template

Reads are open to any authenticated admin; writes are super_admin-only
(defining property-wide recurring work is a privileged act), mirroring the
/api/admin/admins gating. The nightly sync worker — not this API — expands
active templates into pm_tasks rounds.

- **Auth** — admin session
- **Returns**
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/admin/pm-templates/route.ts`](../apps/web/app/api/admin/pm-templates/route.ts)

### `POST /api/admin/pm-templates`

Admin API for preventive-maintenance templates.
GET  /api/admin/pm-templates — templates with round stats + header summary
POST /api/admin/pm-templates — create a template

Reads are open to any authenticated admin; writes are super_admin-only
(defining property-wide recurring work is a privileged act), mirroring the
/api/admin/admins gating. The nightly sync worker — not this API — expands
active templates into pm_tasks rounds.

- **Auth** — admin session, capability `super_admin`
- **Returns**
  - `201` → `{ data }`
  - `400` → `{ error, details }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/admin/pm-templates/route.ts`](../apps/web/app/api/admin/pm-templates/route.ts)

### `PATCH /api/admin/pm-templates/:id`

Admin API — edit or delete one PM template.
PATCH  /api/admin/pm-templates/{id} — update any editable field (incl. active)
DELETE /api/admin/pm-templates/{id} — delete (pm_tasks cascade in the DB)

Gated to super_admin, same as /api/admin/admins: templates fan out into
property-wide task rounds, so changing or deleting one is privileged.

- **Auth** — admin session, capability `super_admin`
- **Returns**
  - `400` → `{ error, details }`
  - `404` → `{ error }`
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/admin/pm-templates/[id]/route.ts`](../apps/web/app/api/admin/pm-templates/[id]/route.ts)

### `DELETE /api/admin/pm-templates/:id`

Admin API — edit or delete one PM template.
PATCH  /api/admin/pm-templates/{id} — update any editable field (incl. active)
DELETE /api/admin/pm-templates/{id} — delete (pm_tasks cascade in the DB)

Gated to super_admin, same as /api/admin/admins: templates fan out into
property-wide task rounds, so changing or deleting one is privileged.

- **Auth** — admin session, capability `super_admin`
- **Returns**
  - `400` → `{ error }`
  - `404` → `{ error }`
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/admin/pm-templates/[id]/route.ts`](../apps/web/app/api/admin/pm-templates/[id]/route.ts)

### `POST /api/admin/push-tokens`

Expo push-token registration for the staff apps.
POST   /api/admin/push-tokens — register/refresh a device token
DELETE /api/admin/push-tokens — deactivate a device token (sign-out)

The maintenance app calls with its per-user `eapi_` Bearer token, so the
row is attributed to the signed-in staff member (requireAdminOrScanner
resolves it the same way the map-annotation routes do). The sync worker
reads the active rows to send emergency work-order pushes.

- **Auth** — admin session or scanner key, capability `property_manager`
- **Returns**
  - `400` → `{ error, details }`
  - `500` → `{ ok, error }`
- **Source** — [`apps/web/app/api/admin/push-tokens/route.ts`](../apps/web/app/api/admin/push-tokens/route.ts)

### `DELETE /api/admin/push-tokens`

Expo push-token registration for the staff apps.
POST   /api/admin/push-tokens — register/refresh a device token
DELETE /api/admin/push-tokens — deactivate a device token (sign-out)

The maintenance app calls with its per-user `eapi_` Bearer token, so the
row is attributed to the signed-in staff member (requireAdminOrScanner
resolves it the same way the map-annotation routes do). The sync worker
reads the active rows to send emergency work-order pushes.

- **Auth** — admin session or scanner key, capability `property_manager`
- **Returns**
  - `400` → `{ error, details }`
  - `500` → `{ ok, error }`
- **Source** — [`apps/web/app/api/admin/push-tokens/route.ts`](../apps/web/app/api/admin/push-tokens/route.ts)

### `GET /api/admin/residents`

- **Auth** — admin session
- **Returns**
  - `500` → `{ residents, total, error }`
- **Source** — [`apps/web/app/api/admin/residents/route.ts`](../apps/web/app/api/admin/residents/route.ts)

### `GET /api/admin/residents/:id`

- **Auth** — admin session
- **Returns**
  - `404` → `{ error }`
  - `500` → `{ (detail), error }`
- **Source** — [`apps/web/app/api/admin/residents/[id]/route.ts`](../apps/web/app/api/admin/residents/[id]/route.ts)

### `POST /api/admin/residents/:id/ban-guest-pass`

- **Auth** — admin session, capability `property_manager`
- **Returns**
  - `200` → `{ message, ban }`
  - `400` → `{ error, details }`
  - `404` → `{ error }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/admin/residents/[id]/ban-guest-pass/route.ts`](../apps/web/app/api/admin/residents/[id]/ban-guest-pass/route.ts)

### `DELETE /api/admin/residents/:id/ban-guest-pass`

- **Auth** — admin session, capability `property_manager`
- **Returns**
  - `200` → `{ message }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/admin/residents/[id]/ban-guest-pass/route.ts`](../apps/web/app/api/admin/residents/[id]/ban-guest-pass/route.ts)

### `POST /api/admin/residents/:id/session-action`

- **Auth** — admin session, capability `property_manager`
- **Returns**
  - `200` → `{ resident }`
  - `400` → `{ error, details }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/admin/residents/[id]/session-action/route.ts`](../apps/web/app/api/admin/residents/[id]/session-action/route.ts)

### `POST /api/admin/resman-units/:id/ban-guest-pass`

- **Auth** — admin session, capability `property_manager`
- **Returns**
  - `200` → `{ message, ban }`
  - `400` → `{ error, details }`
  - `404` → `{ error }`
  - `422` → `{ error }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/admin/resman-units/[id]/ban-guest-pass/route.ts`](../apps/web/app/api/admin/resman-units/[id]/ban-guest-pass/route.ts)

### `DELETE /api/admin/resman-units/:id/ban-guest-pass`

- **Auth** — admin session, capability `property_manager`
- **Returns**
  - `200` → `{ message }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/admin/resman-units/[id]/ban-guest-pass/route.ts`](../apps/web/app/api/admin/resman-units/[id]/ban-guest-pass/route.ts)

### `GET /api/admin/scanners`

- **Auth** — admin session
- **Returns**
  - `500` → `{ scanners, error }`
- **Source** — [`apps/web/app/api/admin/scanners/route.ts`](../apps/web/app/api/admin/scanners/route.ts)

### `POST /api/admin/scanners`

- **Auth** — admin session, capability `security_manager`
- **Returns**
  - `200` → `{ scanner, … }`
  - `400` → `{ error, details }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/admin/scanners/route.ts`](../apps/web/app/api/admin/scanners/route.ts)

### `PATCH /api/admin/scanners/:scannerId`

- **Auth** — admin session, capability `security_manager`
- **Returns**
  - `200` → `{ scanner, … }`
  - `400` → `{ error, details }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/admin/scanners/[scannerId]/route.ts`](../apps/web/app/api/admin/scanners/[scannerId]/route.ts)

### `GET /api/admin/stats`

- **Auth** — admin session
- **Returns**
  - `500` → `{ (await), error }`
- **Source** — [`apps/web/app/api/admin/stats/route.ts`](../apps/web/app/api/admin/stats/route.ts)

### `GET /api/admin/unifi-cameras`

UniFi Protect camera discovery — feeds the pairing picker in the camera
editor. Admin session only; the guard app never needs the raw inventory.

GET /api/admin/unifi-cameras → { consoles: [{ consoleId, consoleName, cameras }] }

- **Auth** — admin session
- **Returns**
  - `502` → `{ consoles, error }`
  - `503` → `{ error }`
- **Source** — [`apps/web/app/api/admin/unifi-cameras/route.ts`](../apps/web/app/api/admin/unifi-cameras/route.ts)

### `GET /api/admin/unit-tags`

Shared unit tags.
GET  — admins and scanner devices; optional ?unit=<number> filter. Purges
expired tags first, so every reader/sync also cleans up.
POST — admins and scanner devices (guards tag units in the field too).

- **Auth** — admin session or scanner key
- **Returns**
  - `500` → `{ tags, error }`
- **Source** — [`apps/web/app/api/admin/unit-tags/route.ts`](../apps/web/app/api/admin/unit-tags/route.ts)

### `POST /api/admin/unit-tags`

Shared unit tags.
GET  — admins and scanner devices; optional ?unit=<number> filter. Purges
expired tags first, so every reader/sync also cleans up.
POST — admins and scanner devices (guards tag units in the field too).

- **Auth** — admin session or scanner key, capability `property_manager`
- **Returns**
  - `400` → `{ error, details }`
  - `409` → `{ error }`
  - `500` → `{ tag, error }`
- **Source** — [`apps/web/app/api/admin/unit-tags/route.ts`](../apps/web/app/api/admin/unit-tags/route.ts)

### `DELETE /api/admin/unit-tags/:tagId`

One unit tag: DELETE removes it. Admins and scanner devices — guards can pull
a tag they no longer need, same as they can add one.

- **Auth** — admin session or scanner key, capability `property_manager`
- **Returns**
  - `404` → `{ error }`
  - `500` → `{ ok, error }`
- **Source** — [`apps/web/app/api/admin/unit-tags/[tagId]/route.ts`](../apps/web/app/api/admin/unit-tags/[tagId]/route.ts)

### `GET /api/admin/utilities/invoice/:billId`

- **Auth** — admin session
- **Returns**
  - `404` → `{ error }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/admin/utilities/invoice/[billId]/route.ts`](../apps/web/app/api/admin/utilities/invoice/[billId]/route.ts)

### `POST /api/admin/utilities/reviews`

- **Auth** — admin session, capability `super_admin`
- **Returns**
  - `400` → `{ error }`
  - `500` → `{ error, ok, reviewed }`
- **Source** — [`apps/web/app/api/admin/utilities/reviews/route.ts`](../apps/web/app/api/admin/utilities/reviews/route.ts)

## /api/mlgw

Memphis Light Gas & Water utility billing.

### `GET /api/mlgw/accounts`

- **Auth** — ResMan API key (via `createListRoute`)
- **Source** — [`apps/web/app/api/mlgw/accounts/route.ts`](../apps/web/app/api/mlgw/accounts/route.ts)

### `GET /api/mlgw/accounts/:id`

- **Auth** — ResMan API key (via `createDetailRoute`)
- **Source** — [`apps/web/app/api/mlgw/accounts/[id]/route.ts`](../apps/web/app/api/mlgw/accounts/[id]/route.ts)

### `GET /api/mlgw/bills`

- **Auth** — ResMan API key (via `createListRoute`)
- **Source** — [`apps/web/app/api/mlgw/bills/route.ts`](../apps/web/app/api/mlgw/bills/route.ts)

### `GET /api/mlgw/bills/:id`

- **Auth** — ResMan API key (via `createDetailRoute`)
- **Source** — [`apps/web/app/api/mlgw/bills/[id]/route.ts`](../apps/web/app/api/mlgw/bills/[id]/route.ts)

### `GET /api/mlgw/payments`

- **Auth** — ResMan API key (via `createListRoute`)
- **Source** — [`apps/web/app/api/mlgw/payments/route.ts`](../apps/web/app/api/mlgw/payments/route.ts)

### `GET /api/mlgw/payments/:id`

- **Auth** — ResMan API key (via `createDetailRoute`)
- **Source** — [`apps/web/app/api/mlgw/payments/[id]/route.ts`](../apps/web/app/api/mlgw/payments/[id]/route.ts)

## /api/resident

Resident-facing routes, authenticated by a per-device token rather than a staff identity.

### `POST /api/resident/entry-token`

- **Auth** — resident device token
- **Returns**
  - `200` → `{ entryToken, qrData, expiresAt }`
  - `401` → `{ error }`
  - `403` → `{ error, reason }`
  - `404` → `{ error }`
- **Source** — [`apps/web/app/api/resident/entry-token/route.ts`](../apps/web/app/api/resident/entry-token/route.ts)

### `POST /api/resident/guest-pass`

- **Auth** — signed Emberly token
- **Returns**
  - `201` → `{ passId, qrData, shareUrl, expiresAt, pass, warning }`
  - `400` → `{ error, details }`
  - `401` → `{ error }`
  - `403` → `{ error, reason, resmanStatus }`
  - `404` → `{ error }`
  - `409` → `{ error, reason, existingPassId, expiresAt, shareUrl }`
  - `429` → `{ error }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/resident/guest-pass/route.ts`](../apps/web/app/api/resident/guest-pass/route.ts)

### `GET /api/resident/guest-passes`

- **Auth** — signed Emberly token
- **Returns**
  - `200` → `{ passes, total }`
  - `401` → `{ error }`
  - `404` → `{ error }`
  - `500` → `{ error }`
- **Source** — [`apps/web/app/api/resident/guest-passes/route.ts`](../apps/web/app/api/resident/guest-passes/route.ts)

### `POST /api/resident/guest-passes/:id/resend`

- **Auth** — signed Emberly token
- **Returns**
  - `401` → `{ error }`
  - `404` → `{ error, reason }`
  - `429` → `{ error }`
  - `500` → `{ error, resent, passId, shareUrl, expiresAt }`
  - `502` → `{ error, reason }`
- **Source** — [`apps/web/app/api/resident/guest-passes/[id]/resend/route.ts`](../apps/web/app/api/resident/guest-passes/[id]/resend/route.ts)

### `POST /api/resident/guest-passes/:id/revoke`

- **Auth** — signed Emberly token
- **Returns**
  - `401` → `{ error }`
  - `404` → `{ error, reason }`
  - `500` → `{ error, revoked, passId, pass }`
- **Source** — [`apps/web/app/api/resident/guest-passes/[id]/revoke/route.ts`](../apps/web/app/api/resident/guest-passes/[id]/revoke/route.ts)

## /api/auth

Sign-in and session issuance.

### `POST /api/auth/resman-heartbeat`

- **Auth** — signed ResMan portal session
- **Returns**
  - `200` → `{ valid, reason, resmanStatus, resmanAccess, nextCheckAfter }`
  - `400` → `{ valid, reason }`
  - `401` → `{ valid, reason }`
  - `403` → `{ valid, reason }`
- **Source** — [`apps/web/app/api/auth/resman-heartbeat/route.ts`](../apps/web/app/api/auth/resman-heartbeat/route.ts)

### `POST /api/auth/resman-session`

- **Auth** — ResMan portal credentials
- **Returns**
  - `200` → `{ (failure.body) }`
  - `400` → `{ error }`
  - `403` → `{ error, reason, resmanStatus, unitNumber, allowedStatuses }`
  - `429` → `{ error }`
  - `500` → `{ requiresSelection, resmanSession, resmanAccess, emberlySession, (failure.body), error }`
  - `502` → `{ error, reason, unitNumber }`
  - `503` → `{ error, reason, missing }`
- **Source** — [`apps/web/app/api/auth/resman-session/route.ts`](../apps/web/app/api/auth/resman-session/route.ts)

### `POST /api/auth/select-resident`

POST /api/auth/select-resident

Called after a multi-resident ResMan login when the user picks who they are.
Validates a short-lived Emberly selection token, then issues a resident-scoped
Emberly session. ResMan session cookies are never stored in the API database.

- **Auth** — resident selection token
- **Returns**
  - `400` → `{ error }`
  - `401` → `{ error }`
  - `404` → `{ error }`
  - `500` → `{ emberlySession, (failure.body), error }`
- **Source** — [`apps/web/app/api/auth/select-resident/route.ts`](../apps/web/app/api/auth/select-resident/route.ts)

### `GET /api/auth/verify`

GET /api/auth/verify

Lightweight Emberly token check. ResMan session heartbeats use
POST /api/auth/resman-heartbeat so raw ResMan session material is supplied
only by the mobile client and never embedded in the Emberly token.

- **Auth** — signed Emberly token
- **Returns**
  - `200` → `{ valid, reason }`
- **Source** — [`apps/web/app/api/auth/verify/route.ts`](../apps/web/app/api/auth/verify/route.ts)

## /api/cron

Scheduled jobs. Bearer `CRON_SECRET`, not a user identity.

### `GET /api/cron/cleanup`

GET: scheduler only (bearer). Deliberately NO admin-cookie fallback — a Lax
session cookie rides a top-level GET navigation, so allowing the cookie here
would let a malicious page trigger this destructive cleanup via CSRF.

- **Auth** — admin session
- **Returns**
  - `401` → `{ error }`
- **Source** — [`apps/web/app/api/cron/cleanup/route.ts`](../apps/web/app/api/cron/cleanup/route.ts)

### `POST /api/cron/cleanup`

POST: the manual admin trigger (admin session cookie / x-admin-key) or the
scheduler bearer. A SameSite=Lax session cookie is NOT attached to a
cross-site POST, so the admin-cookie path is not CSRF-exploitable here.

- **Auth** — admin session
- **Returns**
  - `401` → `{ error }`
- **Source** — [`apps/web/app/api/cron/cleanup/route.ts`](../apps/web/app/api/cron/cleanup/route.ts)

### `GET /api/cron/monitor`

GET: scheduler bearer only. No admin-cookie fallback — a Lax cookie rides a
top-level GET, so accepting it here would let a page trigger this write via
CSRF. Same reasoning as /api/cron/cleanup.

- **Auth** — admin session
- **Returns**
  - `401` → `{ error }`
- **Source** — [`apps/web/app/api/cron/monitor/route.ts`](../apps/web/app/api/cron/monitor/route.ts)

### `POST /api/cron/monitor`

POST: the manual admin trigger (session cookie / x-admin-key) or the
scheduler bearer. A SameSite=Lax cookie is not attached to a cross-site POST,
so the cookie path is not CSRF-exploitable.

- **Auth** — admin session
- **Returns**
  - `401` → `{ error }`
- **Source** — [`apps/web/app/api/cron/monitor/route.ts`](../apps/web/app/api/cron/monitor/route.ts)

## /api/entry-logs

Gate entry records.

### `POST /api/entry-logs/:entryLogId/photos`

- **Auth** — scanner key
- **Returns**
  - `201` → `{ photo }`
- **Source** — [`apps/web/app/api/entry-logs/[entryLogId]/photos/route.ts`](../apps/web/app/api/entry-logs/[entryLogId]/photos/route.ts)

## /api/health

Liveness probe.

### `GET /api/health`

- **Auth** — **public by design** — liveness probe — returns no data
- **Returns**
  - `200` → `{ status, service, timestamp }`
- **Source** — [`apps/web/app/api/health/route.ts`](../apps/web/app/api/health/route.ts)

## /api/mcp

The Model Context Protocol server. See [MCP Tools](MCP-Tools.md) for the tool surface.

### `GET /api/mcp`

Read-only staff MCP server endpoint (Streamable-HTTP style, stateless).

POST /api/mcp with a JSON-RPC message (or batch). Gated by a per-staff bearer
token (Authorization: Bearer <emcp_…>) resolved against access_tokens (kind
`mcp`); each tool call is attributed in access_token_audit_log. Read-only —
the tools only list/get the ResMan/MLGW mirror data through the query engine.

- **Auth** — **public by design** — returns 405 with `Allow: POST` — the MCP surface authenticates on POST
- **Returns**
  - `405` → `{ error }`
- **Source** — [`apps/web/app/api/mcp/route.ts`](../apps/web/app/api/mcp/route.ts)

### `POST /api/mcp`

Read-only staff MCP server endpoint (Streamable-HTTP style, stateless).

POST /api/mcp with a JSON-RPC message (or batch). Gated by a per-staff bearer
token (Authorization: Bearer <emcp_…>) resolved against access_tokens (kind
`mcp`); each tool call is attributed in access_token_audit_log. Read-only —
the tools only list/get the ResMan/MLGW mirror data through the query engine.

- **Auth** — MCP bearer token
- **Returns**
  - `200` → `{ (response) }`
  - `202` → `{ (responses) }`
  - `400` → `{ jsonrpc, id, error }`
- **Source** — [`apps/web/app/api/mcp/route.ts`](../apps/web/app/api/mcp/route.ts)

## /api/verify-pass

Guest-pass verification, called by the scanner at the gate.

### `POST /api/verify-pass`

- **Auth** — scanner key
- **Source** — [`apps/web/app/api/verify-pass/route.ts`](../apps/web/app/api/verify-pass/route.ts)

## /api/scanner

Gate-scanner device enrolment.

### `GET /api/scanner/me`

Who am I, and how have I been doing — the scanner's own identity and scan
counts for the app's settings page. Scanner-credential only: an `eapi_` API
token has no device identity, so there is no "me" to answer with.

"Scans" are attempts: successful entries live in `entry_logs`; refusals are
only recorded as `admin_alerts` (verify-pass writes one per denial), so the
refused counts are read from there via metadata.scannerId.

- **Auth** — scanner key
- **Returns**
  - `401` → `{ error }`
  - `404` → `{ error }`
  - `500` → `{ data, error }`
- **Source** — [`apps/web/app/api/scanner/me/route.ts`](../apps/web/app/api/scanner/me/route.ts)

---

_Regenerate with `bun run docs:api`._
