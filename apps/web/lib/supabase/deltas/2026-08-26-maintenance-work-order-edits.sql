-- maintenance_work_order_edits — the durable write queue between the
-- maintenance app and ResMan. The web routes (/api/resman/work-orders/[id]/
-- edit|close) enqueue one row per requested change; the sync worker's
-- flush-work-order-writes job drains it by replaying ResMan's edit form
-- (edits and closes ONLY — delete and cancel are refused by the writer).
-- The work-order reference is soft: a queued row must survive the sync's
-- delete-missing pass, and the flush fails it cleanly if the mirror row is
-- gone. resman_work_orders itself is NEVER written by this path — the mirror
-- absorbs an applied change on the next sync pass.
create table if not exists public.maintenance_work_order_edits (
  id uuid primary key default gen_random_uuid(),
  resman_work_order_id text not null,  -- soft ref (mirror row may be deleted by sync)
  kind text not null check (kind in ('edit','close')),
  patch jsonb not null,                -- edit: technician/description/completionNotes/scheduledAt · close: note/completedAt
  requested_by text not null default '',        -- staff display name from token label
  requested_by_role text not null default '',
  requested_by_admin_id text not null default '',
  status text not null default 'queued' check (status in ('queued','applying','applied','failed','superseded')),
  attempts integer not null default 0,
  last_error text not null default '',
  applied_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- One live queued row per work order and kind: a retried request from the
-- app's offline queue updates the row in place instead of stacking duplicates
-- (the app already merges its patches client-side before re-sending).
create unique index if not exists maintenance_wo_edits_one_queued_idx
  on public.maintenance_work_order_edits (resman_work_order_id, kind)
  where status = 'queued';

create index if not exists maintenance_wo_edits_status_idx
  on public.maintenance_work_order_edits (status, created_at);
create index if not exists maintenance_wo_edits_work_order_idx
  on public.maintenance_work_order_edits (resman_work_order_id);

-- Service-role only, like the other Emberly-owned tables: RLS on, no policies.
alter table public.maintenance_work_order_edits enable row level security;
