-- Re-queue the application leases the skeleton write erased.
--
-- WHAT HAPPENED. `scrapeUnit` writes a skeleton for every non-current,
-- non-terminal lease, built from the unit's lease-history table — status, term
-- dates, move-out date, rent, resident name. mapLease filled every other
-- column with "" or null and the upsert wrote those blanks over what the deep
-- pass had read from the resident page.
--
-- Measured 2026-08-15: 40 of the 45 application leases had leasing_agent,
-- approval_status, application_date, signed_date and move_in_date wiped. Their
-- deep_synced_at read 02:51 UTC and their updated_at 14:55 — the deep pass
-- captured them, the unit pass erased them six hours later. The resident pages
-- still hold the data (verified on 8: "Leasing agent: Kalesea Christely",
-- "Approval status: Approved").
--
-- WHY IT NEVER SELF-HEALED. `leaseScrapeTier` returns "skip" for a Pending or
-- Approved lease that already carries deep_synced_at — the tier exists so
-- settled applications are not re-scraped every run. So once blanked, the deep
-- pass never looked at them again and the blanks were permanent.
--
-- WHAT THIS DOES. Clears deep_synced_at on application leases carrying the
-- signature of the clobber (no leasing agent recorded), which is the only
-- thing making the deep pass skip them. The next sync:lease-details run
-- re-reads each resident page and restores the fields. The scraper fix
-- (withoutUnobservedFields + a separate skeleton upsert batch) is what stops
-- it happening again.
--
-- Nothing is deleted and no lease data is written here: only the marker that
-- says "already captured".

update public.resman_leases
set deep_synced_at = null
where deep_synced_at is not null
  and coalesce(leasing_agent, '') = ''
  and status is not null
  and lower(status) in ('pending', 'approved', 'applicant', 'prospect');
