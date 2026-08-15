-- When an application was approved, and by whom.
--
-- The Pipeline's tracker shows applied → approved → signed → move-in, and the
-- approved step was the only one with no date. ResMan has no approval-date
-- FIELD anywhere: the resident page carries "Approval status" (a bare
-- "Approved" / "Denied") with nothing beside it, and the Applications and
-- Screening Results tabs come back empty on this property.
--
-- The Activity Log is the only place the moment is recorded:
--
--   8/14/2026 11:25:33 AM | Resident(s) Ariauna Williams approved for move in
--                           to unit 3714 DU-2 | Natalie Pointer
--
-- Verified identical on every approved lease sampled, and absent on an
-- application not yet approved — so the line's presence is itself an approval
-- signal, and a more reliable one than approval_status, which is blank on the
-- shallow skeletons the unit pass writes.
--
-- Populated by sync:lease-details for leases still in an application status
-- (Pending / Approved / Applicant / Prospect, excluding Pending Renewal). It
-- costs one extra request per such lease — about 45 on this property — rather
-- than one per full-tier lease, which would be most of a sync run.

alter table public.resman_leases
  add column if not exists approved_date date,
  add column if not exists approved_by text not null default '';

comment on column public.resman_leases.approved_date is
  'When the application was approved, parsed from the ResMan Activity Log.';
comment on column public.resman_leases.approved_by is
  'Staff member the ResMan Activity Log credits with the approval.';
