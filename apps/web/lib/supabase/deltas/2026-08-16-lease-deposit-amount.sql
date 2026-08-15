-- Whether a deposit has been taken on an application, and how much.
--
-- The Pipeline needs "no deposit" as an exception flag, and there is no
-- deposit FIELD anywhere in ResMan's resident or lease pages to read it from.
-- The only record is a line in the Activity Log, which sync:lease-details
-- already fetches for every application-status lease:
--
--   7/16/2026 3:41:02 PM | Added Security Deposit of amount 300.00 | Nicole Jones
--
-- Measured over the 47 applications on this property: 26 carry the line, 19
-- do not — so "no deposit" is a real and common condition, not a scrape gap.
--
-- The log also carries "Deleted Security Deposit of amount …". The parser
-- matches the verb, not the noun, so a deposit that was taken back off the
-- lease does not read as one that is held.
--
-- Null means the log has no Added line: no deposit taken. It is never written
-- by the skeleton pass, which cannot see the Activity Log at all.

alter table public.resman_leases
  add column if not exists deposit_amount numeric(12,2),
  add column if not exists deposit_logged_date date;

comment on column public.resman_leases.deposit_amount is
  'Security deposit added, parsed from the ResMan Activity Log. Null = no deposit taken.';
comment on column public.resman_leases.deposit_logged_date is
  'Date the ResMan Activity Log recorded the security deposit.';
