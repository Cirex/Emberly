-- Unit-level guest-pass suspension.
--
-- guest_pass_bans hangs off `residents` — our first-party registry, which only
-- has a row once a tenant registers a login. A household that never enrolled
-- could not have guest visits disabled at all. This table keys the suspension
-- to the ResMan unit itself, so it works for every unit regardless of
-- enrollment.
--
-- `unit_number` is stored alongside the ResMan id because that's the only
-- bridge the first-party side has: residents.unit_id and entry_logs record the
-- unit *number* string, so both the guest-pass creation route and verify-pass
-- enforce by number while admins act by resman_unit_id.
--
-- Enforced in three places:
--   1. POST /api/resident/guest-pass    — creation blocked (403)
--   2. verify-pass guest scan           — already-issued passes denied at the gate
--   3. unit detail (admin + guard app)  — "Guests allowed: No"
--
-- Service-role only (RLS on, no policies), like the rest of the first-party
-- tables.

create table if not exists public.guest_pass_unit_bans (
  resman_unit_id text primary key,
  unit_number text not null,
  reason text,
  banned_by text not null,
  banned_at timestamptz not null default now()
);

create index if not exists guest_pass_unit_bans_unit_number_idx
  on public.guest_pass_unit_bans (unit_number);

alter table public.guest_pass_unit_bans enable row level security;
