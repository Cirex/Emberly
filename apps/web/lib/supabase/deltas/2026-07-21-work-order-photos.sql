-- Work-order completion photos: techs attach before/after photos when closing
-- a work order in the maintenance app. ResMan write-back is deferred (the
-- close route is a stub), so bytes live in Supabase Storage and these rows
-- carry the pointer + author; the photos ride into ResMan when the deferred
-- write path is built. Brings a database matching the pre-photo schema.sql up
-- to the new shape.
--
-- STORAGE BUCKET: this delta provisions the private `work-order-photos`
-- bucket via the `insert into storage.buckets` statement below — the same
-- SQL pattern schema.sql uses for `entry-log-photos` and `mlgw-bills`.
-- (The `map-annotation-photos` bucket was provisioned outside SQL; this one
-- is provisioned here so nothing manual is needed. If this delta is applied
-- with a role that cannot write `storage.buckets`, create the bucket in the
-- Supabase dashboard instead: name `work-order-photos`, private.)

create table if not exists public.work_order_photos (
  id uuid primary key default gen_random_uuid(),
  resman_work_order_id text not null
    references public.resman_work_orders(resman_work_order_id) on delete cascade,
  phase text not null default 'completion' check (phase in ('before','after','completion')),
  storage_path text not null,
  content_type text not null,
  byte_size integer not null check (byte_size >= 0 and byte_size <= 10485760),
  created_by text not null default '',          -- staff display name
  created_by_admin_id text not null default '',
  created_at timestamptz default now(),
  deleted_at timestamptz
);

create index if not exists work_order_photos_work_order_idx
  on public.work_order_photos (resman_work_order_id, deleted_at);

-- Service-role only, like the other photo tables: RLS on with no policies.
alter table public.work_order_photos enable row level security;

-- Private storage bucket for work-order completion photos (service role only).
insert into storage.buckets (id, name, public)
values ('work-order-photos', 'work-order-photos', false)
on conflict (id) do update
set public = excluded.public;
