-- ============================================================================
-- Backfill mirror rows whose synced_at froze at their first INSERT
-- ============================================================================
--
-- WHY. `synced_at timestamptz default now()` fires on INSERT only — an
-- `ON CONFLICT DO UPDATE` never re-applies a column default. Every mirror table
-- whose mapper did not write the column therefore froze its synced_at at the
-- moment its last brand-new row appeared, while the rows themselves were
-- re-upserted on every pass and `updated_at` moved with them.
--
-- c413781 fixed the four ResMan writers (resman_properties, resman_buildings,
-- resman_floorplans, resman_units) going forward. The MLGW mappers had the same
-- hole and are fixed alongside this delta (supabase/sync/src/mlgw/jobs.ts):
-- toAccountRow / toBillRow are faithful ports of Swift importers that had no
-- such column, so mlgw_accounts and mlgw_bills sat at their 2026-07-22 seed.
--
-- Neither fix repairs rows already in the table, which is what this delta is
-- for.
--
-- WHAT. synced_at := updated_at, for rows where synced_at is behind.
--
-- updated_at is the honest value here, not now(). Every one of these tables
-- runs the UNCONDITIONAL public.update_updated_at_column() trigger (only
-- resman_work_orders uses touch_updated_at_on_change — see
-- 2026-07-24-work-order-change-detection.sql), and upsertMirror rewrites every
-- scraped row on every pass. So on these tables updated_at already means
-- exactly what synced_at is supposed to mean: the last time the scraper wrote
-- this row. Stamping now() instead would claim an observation that never
-- happened.
--
-- The triggers are disabled around the UPDATE for the same reason. They fire on
-- any UPDATE and would set updated_at = now(), which both destroys the
-- last-write signal and leaves synced_at < updated_at again — so a re-run would
-- chase its own tail forever instead of being idempotent.
--
-- Idempotent: the WHERE clause is empty on a second run. Reversible only in the
-- sense that the prior values were themselves wrong (a single frozen seed
-- instant per table); the pre-change state was:
--     resman_properties  2026-07-18T13:26:41  x1
--     resman_buildings   2026-07-18T13:27:19  x194
--     resman_floorplans  2026-07-18T14:42:50  x18
--     resman_units       2026-07-18T13:26:42  x891
--     mlgw_accounts      2026-07-22T04:07:23  x670
--     mlgw_bills         2026-07-22T04:07:23  x2500 / 04:07:24 x1042
--
-- The four ResMan tables were corrected ahead of this delta by a live sync run
-- on the fixed code (run-units, run-unit-info, run-unit-details), which is why
-- their clauses are expected to match zero rows. They are listed anyway: the
-- delta documents the whole affected set, and the guard makes running it against
-- an environment that has NOT had that sync run do the right thing.
--
-- No explicit begin/commit: scripts/apply-supabase-migrations.mjs runs each
-- delta inside its own transaction, so the trigger disable/enable pair either
-- lands whole or rolls back whole.

alter table public.resman_properties disable trigger resman_properties_updated_at;
alter table public.resman_buildings  disable trigger resman_buildings_updated_at;
alter table public.resman_floorplans disable trigger resman_floorplans_updated_at;
alter table public.resman_units      disable trigger resman_units_updated_at;
alter table public.mlgw_accounts     disable trigger mlgw_accounts_updated_at;
alter table public.mlgw_bills        disable trigger mlgw_bills_updated_at;

update public.resman_properties set synced_at = updated_at
  where updated_at is not null and (synced_at is null or synced_at < updated_at);
update public.resman_buildings set synced_at = updated_at
  where updated_at is not null and (synced_at is null or synced_at < updated_at);
update public.resman_floorplans set synced_at = updated_at
  where updated_at is not null and (synced_at is null or synced_at < updated_at);
update public.resman_units set synced_at = updated_at
  where updated_at is not null and (synced_at is null or synced_at < updated_at);
update public.mlgw_accounts set synced_at = updated_at
  where updated_at is not null and (synced_at is null or synced_at < updated_at);
update public.mlgw_bills set synced_at = updated_at
  where updated_at is not null and (synced_at is null or synced_at < updated_at);

alter table public.resman_properties enable trigger resman_properties_updated_at;
alter table public.resman_buildings  enable trigger resman_buildings_updated_at;
alter table public.resman_floorplans enable trigger resman_floorplans_updated_at;
alter table public.resman_units      enable trigger resman_units_updated_at;
alter table public.mlgw_accounts     enable trigger mlgw_accounts_updated_at;
alter table public.mlgw_bills        enable trigger mlgw_bills_updated_at;
