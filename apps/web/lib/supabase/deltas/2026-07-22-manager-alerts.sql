-- Manager app push alerts.
--
-- 1. push_tokens.alert_kinds — the manager app registers with the alert kinds
--    the device has switched on, so the sync worker can respect the per-kind
--    settings toggles server-side. Empty (the default, and what every existing
--    maintenance row keeps) means "no recorded preference" = all kinds.
--    The existing `app` column stays the fleet discriminator: maintenance
--    devices are 'maintenance' (the column default, so historic rows are
--    already correct) and the manager app registers as 'manager'.
--
-- 2. manager_alert_notifications — the once-only ledger. The manager-alerts
--    job inserts a row BEFORE sending, and (kind, subject_key) is unique, so
--    an alert can never re-fire. Only balance_threshold rows are deleted, when
--    a unit's balance falls back under the re-arm band.
--
-- Service-role only (RLS on, no policies), like the rest of the first-party
-- tables. Brings a database matching the pre-manager-alerts schema.sql up to
-- the new shape.

alter table public.push_tokens
  add column if not exists alert_kinds text[] not null default '{}';

create table if not exists public.manager_alert_notifications (
  id uuid primary key default gen_random_uuid(),
  kind text not null
    constraint manager_alert_notifications_kind_check check (kind in (
      'application_received',
      'lease_signed',
      'balance_threshold',
      'eviction_milestone',
      'utility_spike'
    )),
  subject_key text not null,             -- source row id; unique with kind
  unit_number text not null default '',
  title text not null default '',
  body text not null default '',         -- PII-light copy as sent
  amount numeric(12,2),
  devices integer not null default 0,    -- tokens the alert was addressed to
  notified_at timestamptz not null default now(),
  created_at timestamptz default now(),
  constraint manager_alert_notifications_subject_unique unique (kind, subject_key)
);

create index if not exists manager_alert_notifications_notified_at_idx
  on public.manager_alert_notifications (notified_at desc);

alter table public.manager_alert_notifications enable row level security;
