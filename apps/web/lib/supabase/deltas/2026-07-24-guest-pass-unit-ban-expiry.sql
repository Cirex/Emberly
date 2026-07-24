-- Expiring guest-pass suspensions.
--
-- A suspension was permanent until someone re-enabled it by hand, while the
-- unit tag that usually prompts it ("NO GUESTS ALLOWED") expires at move-out.
-- So the label lifted when the resident left and the enforcement did not — the
-- next household would have inherited a ban nobody set for them.
--
-- Adopts the tag vocabulary verbatim (see lib/unit-expiry.ts), so the two are
-- evaluated by one engine:
--   never          — until an admin lifts it (previous behaviour, the default)
--   date/duration  — concrete expires_at, swept by the indexed query
--   move_out       — bound to the lease it was set against; lifts when that
--                    lease ends or the unit goes vacant
--   status_change  — watches the lease status it was set at
--
-- Existing rows default to 'never', which is exactly what they were.

alter table public.guest_pass_unit_bans
  add column if not exists expiry_kind text not null default 'never',
  add column if not exists expires_at timestamptz,
  add column if not exists bound_lease_id text,
  add column if not exists status_trigger text;

alter table public.guest_pass_unit_bans
  drop constraint if exists guest_pass_unit_bans_expiry_kind_check;
alter table public.guest_pass_unit_bans
  add constraint guest_pass_unit_bans_expiry_kind_check
  check (expiry_kind in ('never', 'date', 'duration', 'move_out', 'status_change'));

-- The time-based purge is a single indexed scan over the due rows.
create index if not exists guest_pass_unit_bans_expires_at_idx
  on public.guest_pass_unit_bans (expires_at)
  where expires_at is not null;
