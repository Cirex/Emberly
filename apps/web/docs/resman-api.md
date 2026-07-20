# Private ResMan + MLGW REST API (`/api/resman/*`, `/api/mlgw/*`)

Read-only REST API over the sync-mirror tables, split by source system:
`/api/resman/*` over the ResMan tables (`resman_*`) and `/api/mlgw/*` over the
utility-billing tables (`mlgw_*`). Both are served by one shared generic engine
(`lib/resman-api.ts` + `lib/resman-resources.ts`) and gated per-caller by a
rotatable API token or a per-scanner credential. It is the private read-only
REST API consumed by the mobile apps.

- **Location:** `emberly-web`, App Router routes under `app/api/resman/*`.
- **Data access:** service-role Supabase client (`lib/supabase/admin.ts`,
  bypasses RLS) — reached **only** after the caller is authenticated.
- **Methods:** `GET` only. Every route is a list endpoint + a by-id detail
  endpoint built from one shared factory (`lib/resman-api.ts`) over a typed
  resource registry (`lib/resman-resources.ts`).

## Authentication

There is no shared API key. Every request authenticates as a specific caller,
one of two kinds (`lib/resman-api-auth.ts`, `requireResmanApiKey`):

1. **Per-caller API token** — a rotatable token minted from the
   `access_tokens` table (kind `api_resman`, `eapi_` prefix, SHA-256 hash-only).
   Present it as `Authorization: Bearer <eapi_…>` or `x-resman-api-key: <eapi_…>`.
   Minted/rotated/revoked from the admin **Access Tokens** page
   (`lib/access-tokens.ts`).
2. **Per-scanner credential** — the security-scanner app authenticates with its
   own device credential: `?scannerId=<id>` in the query string plus the scanner
   secret via `Authorization: Bearer <secret>` or `x-scanner-key: <secret>`
   (`lib/scanner-auth.ts`, `scanner_devices` table). This is the same credential
   the scanner uses to verify guest passes, so each scanner is a single
   rotatable app-identity across unit sync and pass verification.

Tokens are validated by hash lookup, never string comparison, and each use bumps
`last_used_at`. Kind is enforced: an MCP token (`emcp_`) is rejected here, and an
`api_resman` token is rejected by the MCP route. Failed attempts are rate-limited
per source IP through the durable `checkRateLimit` bucket (fail-closed); a valid
caller short-circuits before the limiter, so legitimate callers are never
throttled.

| Condition | Status |
|---|---|
| Missing / malformed / unknown token or scanner credential | `401 { "error": "Unauthorized" }` |
| Wrong-kind token (e.g. MCP token) | `401 { "error": "Unauthorized" }` |
| Repeated failures, bucket exhausted | `429 { "error": "Too many attempts" }` |
| Detail id not found | `404 { "error": "Not found" }` |
| Unexpected server error | `500 { "error": "Internal server error" }` |

## Response envelope

**List** — `GET /api/resman/<resource>`:

```json
{
  "data": [ { ...allowlisted columns... } ],
  "pagination": { "limit": 50, "offset": 0, "count": 1234, "hasMore": true }
}
```

**Detail** — `GET /api/resman/<resource>/{id}`:

```json
{ "data": { ...allowlisted columns... } }
```

`{id}` is the table's natural primary key (e.g. `resman_unit_id`,
`resman_lease_id`, MLGW composite `id`).

## Pagination

Offset-based, consistent across all list endpoints:

- `limit` — default **50**, clamped to **1..200**.
- `offset` — default **0**, negative coerced to 0.
- `count` in the envelope is the exact total for the current filter set;
  `hasMore = offset + returned < count`.

Non-numeric params fall back to defaults (never error).

## Endpoints & filters

All list endpoints accept `limit`, `offset`, plus the equality filters below.
Unknown query params are ignored. Boolean filters accept only `true`/`false`.

| Resource | List / Detail | Table | Filters |
|---|---|---|---|
| Properties | `/api/resman/properties` · `/{id}` | `resman_properties` | `account` |
| Buildings | `/api/resman/buildings` · `/{id}` | `resman_buildings` | `property` |
| Floorplans | `/api/resman/floorplans` · `/{id}` | `resman_floorplans` | `property` |
| Units | `/api/resman/units` · `/{id}` | `resman_units` | `property`, `building`, `floorplan`, `lease_status`, `occupancy_status` |
| Leases | `/api/resman/leases` · `/{id}` | `resman_leases` | `property`, `unit`, `unit_lease_group_id`, `status`, `is_current_lease` (bool) |
| Residents | `/api/resman/residents` · `/{id}` | `resman_residents` | `lease`, `person`, `is_primary` (bool) |
| Transactions | `/api/resman/transactions` · `/{id}` | `resman_transactions` | `property`, `unit`, `lease`, `transaction_type`, `category` |
| Work orders | `/api/resman/work-orders` · `/{id}` | `resman_work_orders` | `property`, `unit`, `status`, `priority`, `callback_status` |
| MLGW accounts | `/api/mlgw/accounts` · `/{id}` | `mlgw_accounts` | `property`, `unit`, `account_number` |
| MLGW bills | `/api/mlgw/bills` · `/{id}` | `mlgw_bills` | `property`, `account`, `is_current` (bool) |
| MLGW payments | `/api/mlgw/payments` · `/{id}` | `mlgw_payments` | `property`, `account`, `reference_number`, `status` |

Example:

```
GET /api/resman/units?property=1659-P1&occupancy_status=Occupied&limit=25&offset=50
Authorization: Bearer <eapi_… or scanner secret with ?scannerId=…>
```

## Field policy (PII allowlist)

This is a **generic, non-role-scoped** API (a caller holds a single broad token,
not a per-staff role), so it must not expose sensitive occupant PII by default
(design §6, and §8 Q3 which is deferred → SAFE default is used).
Each resource has an explicit **column allowlist** (`selectColumns` in
`lib/resman-resources.ts`): only allowlisted columns are ever queried, and the
response is additionally projected onto the public column set, so a withheld
column cannot leak even if the query changed. The allowlists are typed against
the generated `Database` row types, so a drift that would expose a withheld
column fails to compile.

**Withheld across all resources:** the `raw` jsonb scrape payloads.

Resource-specific policy:

| Resource | Withheld (never returned) | Notes |
|---|---|---|
| `resman_residents` | `birthdate`, `drivers_license`, `drivers_license_state`, `identification`, `email`, `phone_numbers`, `raw` | Occupant PII. Returns operational identity only: names, person/lease ids, `gender`, `household_status`, `language`, `is_primary`. Contact values are replaced by **presence booleans** `has_email` / `has_phone` (design §6: "contact-presence booleans"). |
| `resman_leases` | `raw` | Lease-level financials (rent/balance) are operational and exposed; occupant PII lives on `resman_residents`, not here. |
| `resman_units` / `resman_properties` / `resman_floorplans` / `resman_buildings` | `raw` (where present) | No occupant PII on these tables. |
| `resman_work_orders` / `resman_transactions` | `raw` (work orders) | Operational maintenance/ledger data. |
| `mlgw_bills` | `file_path`, `raw` | `file_path` points to the private Storage PDF (full billing PII); withheld. Structured amounts / per-commodity usage / itemized fee totals are exposed. |
| `mlgw_payments` | `detail_text` | Card fields were already dropped from the schema (§8 Q4). Free-text `detail_text` is withheld; amount/date/method/status/reference are exposed. |
| `mlgw_accounts` | — | No sensitive fields. |

### Resident child tables are intentionally not exposed

`resman_lease_employment` (employer + income), `resman_lease_insurance` (policy
numbers), `resman_lease_vehicles`, `resman_lease_addresses`, and
`resman_lease_alternate_contacts` are **not** served by this generic,
non-role-scoped API. Employment income and insurance policy numbers are
explicitly sensitive (design §6 / §8 Q3), and the remaining child tables carry
prior-address and third-party-contact PII. These belong behind the per-staff,
role-scoped MCP server (milestone 8), not a broad API token. This is a deliberate decision
of the SAFE default; revisit if/when §8 Q3 is resolved with a scoped
parameter or a separately-gated endpoint.

## Extending

Add a resource by appending a `defineResource({...})` entry in
`lib/resman-resources.ts` (typed column allowlist + filters) and two route files
(`app/api/resman/<name>/route.ts` → `createListRoute`, `.../[id]/route.ts` →
`createDetailRoute`). No engine changes needed.
