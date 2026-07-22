-- Insurance actions: the manager app's insurance-compliance follow-up trail.
-- Property managers record proof requests, second notices and manual
-- verifications against a lease from the Compliance board. ResMan stays the
-- source of the policy record (resman_lease_insurance); Emberly owns what we
-- did about it — the delinquency_actions pattern again. "Lapse detected" rows
-- are NOT stored: lapse is derived from the policy end date on device. The
-- lease reference is soft — the sync's delete-missing pass may remove a
-- lease, but the follow-up history must survive it. Brings a database
-- matching the pre-compliance-board schema.sql up to the new shape.

create table if not exists public.insurance_actions (
  id uuid primary key default gen_random_uuid(),
  resman_lease_id text not null,       -- soft ref (lease may be deleted by sync)
  unit_number text not null default '',
  kind text not null check (kind in ('proof_requested','second_notice','verified','note')),
  note text not null default '',
  created_by text not null default '', -- staff display name from token label
  created_by_admin_id text not null default '',
  created_at timestamptz default now(),
  deleted_at timestamptz
);

create index if not exists insurance_actions_lease_idx
  on public.insurance_actions (resman_lease_id, deleted_at);

-- Service-role only, like the other Emberly-owned tables: RLS on, no policies.
alter table public.insurance_actions enable row level security;
