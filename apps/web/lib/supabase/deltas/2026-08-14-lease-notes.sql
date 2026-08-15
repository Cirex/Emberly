-- lease_notes — the shared staff notes thread on a lease (manager app,
-- pipeline detail sheet). Emberly-owned write surface, the delinquency_actions
-- pattern again: any staff role posts free-text notes against a lease; ResMan
-- is never touched. The lease reference is soft — the sync's delete-missing
-- pass may remove a lease, but the conversation must survive it — so rows are
-- soft deleted (deleted_at) and never cascade.
create table if not exists public.lease_notes (
  id uuid primary key default gen_random_uuid(),
  resman_lease_id text not null,       -- soft ref (lease may be deleted by sync)
  unit_number text not null default '',
  body text not null,
  created_by text not null default '', -- staff display name from token label
  created_by_role text not null default '', -- token role, shown next to the name
  created_by_admin_id text not null default '',
  created_at timestamptz default now(),
  deleted_at timestamptz
);

create index if not exists lease_notes_lease_idx
  on public.lease_notes (resman_lease_id, deleted_at);

-- Service-role only, like the other Emberly-owned tables: RLS on, no policies.
alter table public.lease_notes enable row level security;
