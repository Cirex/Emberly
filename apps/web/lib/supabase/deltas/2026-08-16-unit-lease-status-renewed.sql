-- Let resman_units.lease_status hold 'Renewed'.
--
-- ResMan's All-Units export emits nine distinct LeaseStatus values. The mirror
-- allowed eight; the ninth, "Renewed", fell outside ALLOWED_LEASE_STATUS in
-- supabase/sync/src/resman/reports/all-units.ts and was written as null. One
-- unit carries it today (3717 QU-1), so nothing meaningful was lost — and the
-- null was arguably the truer value, since that resident sits on a Current
-- lease running to Jul 2027 while ResMan's unit-level status still names the
-- superseded one. What was wrong is that the drop was SILENT.
--
-- For the record, since it is the question that surfaced this: "Evicted" and
-- "Former" are deliberately NOT added. ResMan never sends them at unit level,
-- and it should not — this column describes the unit's current or incoming
-- lease, and a unit whose tenancy has ended has none (it sends an empty
-- string; 277 of 891 units, every one vacant). A departed tenancy's outcome
-- belongs to resman_leases.status.

alter table public.resman_units
  drop constraint if exists resman_units_lease_status_check;

alter table public.resman_units
  add constraint resman_units_lease_status_check
  check (
    lease_status is null
    or lease_status in (
      'Current','Under Eviction','Notice to Vacate','Month to Month',
      'Pending','Pending Renewal','Renewed','Cancelled'
    )
  );
