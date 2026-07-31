-- ============================================================================
-- public.unit_snapshots — per-unit daily history
-- ============================================================================
--
-- The ResMan mirror UPSERTS current state, so resman_units has no past. Every
-- per-unit question about time is therefore unanswerable today:
--
--   * how long has 1727 LP-3 been vacant?
--   * which units turned over most this year?
--   * whose balance has been climbing for three months?
--   * did this unit's status actually change, or has it always read Vacant?
--
-- property_snapshots answers the same questions at PROPERTY level and has since
-- 2024-07-21, which is what made the gap easy to miss: the headline trend works
-- while nothing underneath it can be drilled into.
--
-- Shape follows property_snapshots deliberately — one row per subject per day,
-- upserted on (date, unit), `source` distinguishing how it was written. That
-- makes it idempotent (a same-day re-run overwrites) and means the MCP's period
-- bucketing and anomaly detection work on it without special cases.
--
-- A snapshot rather than change-capture. Change-capture is smaller and records
-- exact transition times, but it cannot answer "how many days was this vacant"
-- without reconstructing state between rows, and it silently loses a day the
-- sync did not run. 891 rows/day is ~325k/year, which is nothing, and every
-- question above becomes a plain aggregate.

create table if not exists public.unit_snapshots (
  snapshot_date date not null,
  resman_unit_id uuid not null,
  -- Denormalised so a history row stays readable after the unit is renumbered
  -- or reassigned; the mirror would only ever show today's value.
  unit_number text,
  resman_building_id uuid,
  resman_floorplan_id uuid,

  occupancy_status text,
  occupied boolean,
  lease_status text,
  availability text,

  balance numeric,
  current_month_balance numeric,
  market_rent numeric,
  lease_rent numeric,
  times_late integer,

  -- Carried per row because they decide whether a unit belongs in an occupancy
  -- RATE, and that has to be answerable for a past date, not just today's.
  holding_unit boolean,
  excluded_from_occupancy boolean,

  move_in_date date,
  move_out_date date,
  lease_end_date date,

  source text not null default 'nightly',
  created_at timestamptz not null default now(),

  primary key (snapshot_date, resman_unit_id)
);

-- The primary key already serves "everything on date D". This serves the other
-- direction — one unit's whole history — which is the per-unit drill-down the
-- table exists for.
create index if not exists unit_snapshots_unit_date_idx
  on public.unit_snapshots (resman_unit_id, snapshot_date desc);

-- Status-over-time scans ("how many were Vacant each month") filter on status
-- and bucket on date.
create index if not exists unit_snapshots_status_date_idx
  on public.unit_snapshots (occupancy_status, snapshot_date);

comment on table public.unit_snapshots is
  'Per-unit daily state. The ResMan mirror upserts current state only; this is the per-unit history. Written by supabase/sync src/run-unit-snapshots.ts.';
comment on column public.unit_snapshots.source is
  'nightly = written by the scheduled job. Any other value marks a manual or backfilled write.';
