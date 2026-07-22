-- Daily property snapshots for the manager app's Trends feature.
--
-- property_snapshots — one row per day: occupancy family, rent roll,
-- balances by aging bucket, delinquent units, turns in progress, open work
-- orders, utility due. Written by the sync worker's nightly snapshots step
-- (source 'nightly'; a same-day re-run overwrites) plus a one-shot lease-span
-- backfill that fills ONLY the occupancy-family columns for the prior 24
-- months (source 'backfill'; it never overwrites an existing row).
--
-- ALL metric columns are nullable on purpose: a null means "series not yet
-- begun", which is what lets the charts label an honest series start instead
-- of faking a flat past (balances cannot be reconstructed retroactively).
--
-- Service-role only (RLS on, no policies), like the rest of the first-party
-- tables. Brings a database matching the pre-snapshots schema.sql up to the
-- new shape.

create table if not exists public.property_snapshots (
  snapshot_date date primary key,
  total_units integer,
  occupied_units integer,
  vacant_units integer,
  occupancy_pct numeric(5,2),
  rent_roll numeric(14,2),
  lease_rent_total numeric(14,2),
  balance_total numeric(14,2),
  balance_0_30 numeric(14,2),
  balance_31_60 numeric(14,2),
  balance_61_90 numeric(14,2),
  balance_90_plus numeric(14,2),
  delinquent_units integer,
  turns_in_progress integer,
  open_work_orders integer,
  utility_due numeric(14,2),
  source text not null default 'nightly'
    constraint property_snapshots_source_check check (source in ('nightly','backfill')),
  created_at timestamptz default now()
);

alter table public.property_snapshots enable row level security;
