-- Delinquency actions: the manager app's collections timeline. Property
-- managers record collection touchpoints (calls, notices served, promises to
-- pay, FED filings, write-offs, …) against a lease. The lease reference is
-- soft — the sync's delete-missing pass may remove a lease, but the action
-- history must survive it. Brings a database matching the pre-manager-app
-- schema.sql up to the new shape.

create table if not exists public.delinquency_actions (
  id uuid primary key default gen_random_uuid(),
  resman_lease_id text not null,       -- soft ref (lease may be deleted by sync)
  resman_unit_id text not null default '',
  unit_number text not null default '',
  kind text not null check (kind in ('note','called','notice_served','promise_recorded','promise_kept','promise_broken','fed_filed','eviction_completed','writeoff','payment_plan')),
  note text not null default '',
  amount numeric(12,2),                -- legal cost or promise amount, context-dependent
  promise_due_date date,               -- only for promise_recorded / payment_plan
  created_by text not null default '', -- staff display name from token label
  created_by_admin_id text not null default '',
  created_at timestamptz default now(),
  deleted_at timestamptz
);

create index if not exists delinquency_actions_lease_idx
  on public.delinquency_actions (resman_lease_id, deleted_at);
create index if not exists delinquency_actions_unit_idx
  on public.delinquency_actions (resman_unit_id, deleted_at);

-- Service-role only, like the other Emberly-owned tables: RLS on, no policies.
alter table public.delinquency_actions enable row level security;
