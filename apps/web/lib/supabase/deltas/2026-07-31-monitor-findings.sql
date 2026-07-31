-- ============================================================================
-- public.monitor_findings — what the nightly monitor noticed
-- ============================================================================
--
-- detect_anomalies and data_freshness only ever fire when a human remembers to
-- ask. Run once by hand they found a bill at 606.74 against a 40.39 baseline
-- that had been sitting for a month, and six mirror tables eleven days stale.
-- Nobody was going to run them daily. This table is where the scheduled run
-- leaves what it saw.
--
-- FINGERPRINT, not a fresh row per night. A finding is identified by what it is
-- about — kind + resource + entity + period — so the same anomaly seen on five
-- consecutive nights is ONE row whose last_seen_at moves. Inserting nightly
-- would bury the new finding under 30 copies of last month's, which is the
-- usual way a monitoring table becomes unreadable and then ignored.
--
-- Findings RESOLVE. A run that no longer produces a finding it produced before
-- stamps resolved_at, so "units stopped syncing" and "units is syncing again"
-- are both visible, and a stale row cannot masquerade as a current alarm.

create table if not exists public.monitor_findings (
  id uuid primary key default gen_random_uuid(),

  -- kind|resource|entity|period. Unique, and the reason a recurring finding
  -- updates instead of accumulating.
  fingerprint text not null unique,

  kind text not null check (kind in ('anomaly', 'staleness')),
  severity text not null check (severity in ('info', 'warn', 'critical')),
  resource text not null,
  -- The subject, for a per-entity finding: an account id, a unit id. Null for
  -- a whole-resource finding like staleness.
  entity text,
  -- The calendar bucket a finding is about, so next month's spike is a NEW
  -- finding rather than an update to this one.
  period text,

  summary text not null,
  detail jsonb,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,

  created_at timestamptz not null default now()
);

-- The read that matters: open findings, worst first, newest first.
create index if not exists monitor_findings_open_idx
  on public.monitor_findings (resolved_at, severity, last_seen_at desc);

create index if not exists monitor_findings_resource_idx
  on public.monitor_findings (resource, kind);

comment on table public.monitor_findings is
  'Findings from the scheduled monitor (/api/cron/monitor). One row per distinct finding, updated in place while it persists and stamped resolved_at when it stops recurring.';
comment on column public.monitor_findings.fingerprint is
  'kind|resource|entity|period — the identity of a finding, so a recurring one updates rather than duplicating.';
