# Migrations

`../schema.sql` is the canonical schema and was verified table-for-table against the live database on 2026-07-03, when all historical migrations were squashed away (single-user deployment — no other environments to replay history against).

On 2026-07-11 the ResMan/MLGW sync-mirror migrations were flattened the same way: `20260711_pm_mlgw_sync.sql` (created `pm_*`) and `20260711_rename_pm_to_resman.sql` (renamed `pm_* → resman_*`) collapsed into a single `20260711_resman_mlgw_sync.sql` that creates the `resman_*`/`mlgw_*` tables directly. It opens with an `alter table if exists pm_* rename to resman_*` bridge, so it is safe whether the target DB is fresh, still on `pm_*`, or already renamed.

On 2026-07-16 everything was flattened into `../schema.sql` again and this directory emptied. All five files —
`20260711_resman_mlgw_sync.sql`, `20260712_resman_unit_enrichment.sql`, `20260713_mcp_tokens.sql`,
`20260713_auth_overhaul.sql`, `20260716_scanner_secret_hash_index.sql` — were applied to production and then deleted per step 4 below. `schema.sql` now carries their end state directly:

- `admin_users` gains `resman_username` (+ a unique partial index) and `last_login_at`; `key_hash` is nullable — admins authenticate against the ResMan staff portal, not a local key.
- `access_tokens` + `access_token_audit_log` (per-user MCP/API bearer tokens, hash-only). The short-lived `resman_mcp_tokens`/`resman_mcp_audit_log` tables they superseded are simply never created, so the intermediate create-then-drop is gone.
- `scanner_devices_secret_hash_key`, a unique partial index making a scanner key self-identifying.

Verified against the live database on 2026-07-16: 38 declared tables = 38 live tables (no drift either direction), and `admin_users` / `access_tokens` / `access_token_audit_log` match column-for-column.

On 2026-07-20 the twelve migrations added since then were flattened into `../schema.sql` and this directory emptied again: map annotation layers/icons, lease deep-sync stamp, ledger sequence, map cameras (+ UniFi label/name/synced fields), first-party annotation photos, unit tags, admin ResMan person identity, and the `resident_entry_token_uses` replay ledger. Each was already reflected in `schema.sql` (audited table/column/index-for-object) except the last, which was folded in during this pass.

Workflow for future schema changes:

1. Add a dated migration file here: `YYYYMMDD_description.sql` (idempotent `if exists` / `if not exists` guards preferred).
2. Update `../schema.sql` and `types/database.ts` to match.
3. Apply it. The runner applies every not-yet-applied `*.sql` in this directory (filename order), tracks what ran in a `public.schema_migrations` ledger, and wraps each file in a transaction, so re-running is safe:
   - Ad-hoc: `SUPABASE_DB_URL=... bun scripts/apply-supabase-migrations.mjs` (or pass specific files).
   - Production: put the direct Postgres URL in a gitignored `.env.production` (see `.env.production.example`) and run `bun run db:migrate:prod`.
4. Once applied everywhere it needs to be, a migration file may be deleted — `schema.sql` remains the source of truth. The `schema_migrations` ledger keeps the historical record even after the file is gone.

To provision a fresh database from scratch, run `schema.sql` directly.
