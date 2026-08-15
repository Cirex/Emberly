-- Leasing signals from the ResMan Activity Log.
--
-- sync:lease-details already fetches the Activity Log for leases still in an
-- application status, to read the approval date. That one page carries more
-- than the approval, and parsing the rest costs no extra requests. Measured
-- across the 45 application leases on this property (797 log rows):
--
--   "Online Application" .......... 35 (78%), and 31 of those leases have NO
--                                   application_date on the resident page, so
--                                   the log is the only record of when they
--                                   applied. The Pipeline's "Applied" step was
--                                   blank on nearly every application.
--   "lease Start Date was changed"  36 (80%), 121 events. 35 of the 36 moved
--                                   LATER — median 39 days, worst 196. On an
--                                   application the start date IS the desired
--                                   move-in, so a date that keeps sliding
--                                   looked identical to a firm one.
--   Signature package sent ........ 7 · signed 2 · VOIDED 2. The only source
--                                   for "lease sent", and a voided package is
--                                   a deal in trouble that nothing surfaced.
--
-- application_date and signed_date are NOT replaced by the log — the resident
-- page wins wherever it states a date, and the log only fills a blank.
--
-- Deliberately NOT taken: the eviction dates in resman_units.delinquency_reason.
-- They are hand-typed ("7/30 WRIT FILED\r\n7/21 COURT\r\n06/15 FED FILED"),
-- carry no year on 99 of 104 lines, and are missing entirely on 12 of the 64
-- units that are demonstrably in an eviction. Consistency there depends on
-- whoever typed it, which is not a foundation to compute from.

alter table public.resman_leases
  add column if not exists original_start_date date,
  add column if not exists start_date_changes integer not null default 0,
  add column if not exists lease_sent_date date,
  add column if not exists lease_voided_date date;

comment on column public.resman_leases.original_start_date is
  'The first start date the lease had, before any change (ResMan Activity Log).';
comment on column public.resman_leases.start_date_changes is
  'How many times the lease start date (an application''s desired move-in) has moved.';
comment on column public.resman_leases.lease_sent_date is
  'When a signature package was sent (ResMan Activity Log).';
comment on column public.resman_leases.lease_voided_date is
  'When a signature package was voided (ResMan Activity Log).';
