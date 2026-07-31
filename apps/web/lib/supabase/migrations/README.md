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

On 2026-08-01 the thirty-two deltas accumulated since then were flattened into `../schema.sql` and `../deltas` emptied. Unlike previous passes this one was **verified mechanically rather than by audit**: a scratch Postgres was built twice — once from `schema.sql` plus every delta in order, once from the flattened `schema.sql` alone — and the two introspections (tables, columns, defaults, nullability, indexes, constraints, functions, triggers, RLS, policies) were diffed object-for-object, then both diffed against production. 1,304 production objects, none unaccounted for.

That diff earned its keep. Three things were wrong that reading the files would not have shown:

- **`check_rate_limit` in `schema.sql` was the un-hardened version.** `2026-07-25-harden-check-rate-limit.sql` added `set search_path` to a `security definer` function; `schema.sql` was never updated to match, so every database provisioned from it would have carried the vulnerability the delta existed to fix. This is the strongest argument for building the file and diffing it rather than trusting a read-through.
- **`resman_transactions_lease_sequence_idx` existed in production but in no file at all** — added by hand and lost by any rebuild. Now declared.
- **Three dead `mcp_*` overloads.** `create or replace function` with a new signature adds a function rather than replacing one, so each capability added to `mcp_aggregate` (p_any, then p_exists) and `mcp_predicate` (p_prefix) left its predecessor behind, exposed as a PostgREST endpoint with a stale table allowlist. Dropped in `2026-08-02-drop-stale-mcp-overloads.sql` after confirming nothing reaches them; a fresh database never had them.

Superseded revisions are deliberately not reproduced in `schema.sql`: `mcp_aggregate` was defined four times and `mcp_predicate` three, and only the end state belongs in a file whose job is to describe the end state.

## This directory is retired — new migrations go in `../deltas`

After the 2026-07-20 flatten, schema changes were written to `../deltas` under a
`YYYY-MM-DD-description.sql` name, but the runner kept reading *this* directory,
which has been empty ever since. A bare `bun run db:migrate:prod` therefore
answered "No migrations to apply" no matter what was pending, and every delta
had to be applied by naming its file explicitly. Four were applied that way
without ever landing a ledger row — `2026-07-21-utility-run-styles.sql`,
`2026-07-23-guest-pass-unit-bans.sql`, `2026-07-24-guest-pass-unit-ban-expiry.sql`,
`2026-07-24-work-order-translations.sql`. All four are idempotent, so on
2026-07-25 they were re-run through the runner (no-ops) purely to reconcile the
ledger, and `MIGRATIONS_DIR` was repointed at `../deltas`.

Workflow for future schema changes:

1. Add a dated file to `../deltas`: `YYYY-MM-DD-description.sql` (idempotent `if exists` / `if not exists` guards preferred).
2. Update `../schema.sql` and `types/database.ts` to match.
3. Apply it. The runner applies every not-yet-applied `*.sql` in `../deltas` (filename order), tracks what ran in a `public.schema_migrations` ledger, and wraps each file in a transaction, so re-running is safe:
   - Ad-hoc: `SUPABASE_DB_URL=... bun scripts/apply-supabase-migrations.mjs` (or pass specific files).
   - Production: put the direct Postgres URL in a gitignored `.env.production` (see `.env.production.example`) and run `bun run db:migrate:prod`.
4. Unlike the old convention above, deltas are **kept** on disk after they run — the ledger, not the filesystem, decides what is still pending. `schema.sql` remains the source of truth for the end state.

To provision a fresh database from scratch, run `schema.sql` directly.
