-- ============================================================================
-- Close the five public.* tables that never got RLS
-- ============================================================================
--
-- WHY. Every table in this database grants `anon` and `authenticated` full
-- SELECT/INSERT/UPDATE/DELETE — that is the Supabase default for the exposed
-- `public` schema, and nothing here has ever revoked it. Confirmed against
-- production: all 49 RLS-enabled tables carry those grants too. So
-- "RLS enabled, no policies" is not belt-and-braces on this project, it is the
-- ONLY barrier. The service role bypasses RLS, which is why every first-party
-- table reads "Service-role only: RLS on, no policies" in schema.sql and why no
-- `create policy` statement exists anywhere in the schema.
--
-- Five tables were created outside that schema file and so never got the one
-- line that makes the pattern work. With RLS off and the default grants intact,
-- each was readable AND writable by anyone holding the project's anon key:
--
--   admin_users_case_merge_backup_20260801   5 rows — email, role, KEY_HASH,
--       resman_username. A copy of admin_users (which IS protected) with the
--       admin credential hashes in it. The most serious of the five by a wide
--       margin; see the note at the bottom — securing it is containment, not
--       the fix.
--   unit_snapshots      2673 rows — per-unit balance, rents, lease status.
--   access_token_changes  15 rows — token label/kind/scope history. Writable
--       meant an audit trail that could be silently edited.
--   monitor_findings      43 rows — monitor output.
--   schema_migrations     55 rows — the migration ledger. Writable meant a
--       deleted row silently re-runs a migration.
--
-- None of the five appears anywhere in the application code except
-- schema_migrations (created by scripts/apply-supabase-migrations.mjs, fixed in
-- the same change as this delta so a fresh environment does not reopen the
-- hole).
--
-- WHAT. `enable row level security`, nothing else. No policies — that is the
-- point, and matches the other 49. Deliberately NOT revoking the anon grants:
-- every other table keeps them and relies on RLS, so revoking here alone would
-- leave two competing conventions and the next table created would follow
-- whichever one its author happened to read. Revoking project-wide is a
-- reasonable hardening, but it is a separate decision, not this fix.
--
-- SAFE. Nothing in this repo authenticates to Supabase with an anon key —
-- every path uses the service role, which bypasses RLS — so no read or write
-- performed by the apps or the sync worker changes behaviour. Verified by grep:
-- no ANON_KEY / PUBLISHABLE_KEY / anonKey reference exists in apps/ or packages/.
--
-- Idempotent, and reversible with `disable row level security` per table.

alter table public.schema_migrations                      enable row level security;
alter table public.unit_snapshots                         enable row level security;
alter table public.monitor_findings                       enable row level security;
alter table public.access_token_changes                   enable row level security;
alter table public.admin_users_case_merge_backup_20260801 enable row level security;

-- ---------------------------------------------------------------------------
-- FOLLOW-UP, deliberately not done here (both destructive, both need a human):
--
--   1. admin_users_case_merge_backup_20260801 should almost certainly be
--      DROPPED, not merely secured. It is a one-off artifact of an admin_users
--      case-merge, it is referenced by no code, and it holds credential hashes
--      that now exist in two places instead of one. If the merge is settled:
--          drop table public.admin_users_case_merge_backup_20260801;
--      Until then RLS keeps it off the public internet.
--
--   2. unit_snapshots (2673 rows) is referenced by no code either; the live
--      snapshot table is property_snapshots. It looks superseded. Worth
--      confirming before dropping — it may be the only copy of that history.
-- ---------------------------------------------------------------------------
