-- ============================================================================
-- Re-queue the leases whose start/end dates were nulled by the deep pass
-- ============================================================================
--
-- WHY. `syncLeaseDetails` scrapes a lease from its DETAIL page, which does not
-- carry the lease term — the term lives in the unit's lease-history table. To
-- reuse the shared scraper it built a SYNTHETIC history row with
-- `leaseStartDate: null, leaseEndDate: null` (scrapers/unit-detail.ts,
-- scrapeLeaseByPersonLeaseId). `mapLease` could not tell "I did not look" from
-- "there is no term", so it emitted nulls and the upsert wrote them over real
-- dates.
--
-- On its own that would self-heal: the next `unit-details` pass reads the
-- history table and puts the dates back. It did not, because of what happens
-- next. The nulled lease still has a terminal status, and now has
-- `deep_synced_at` set — which is exactly the archived-lease skip in
-- `loadArchivedLeaseIds`. From then on `unit-details` skips it, and the nulls
-- are permanent.
--
-- Measured 2026-08-11, after a full `unit-details` run: 1,242 leases, 192 with
-- no term. All 192 deep-synced at 19:xx by the lease-details pass, all 192
-- flagged current/most-recent, and every one terminal — Evicted 75, Cancelled
-- 78, Former 36, Renewed 2, Approved 1. The 1,050 that DO have dates are the
-- non-terminal ones the skip never caught. That split is the fingerprint.
--
-- THE CODE FIX SHIPS SEPARATELY and must land first: `withoutTermDates()` in
-- scrapers/leases.ts strips the two columns from the lease-details write so the
-- upsert leaves them alone. Without it, this delta buys one clean `unit-details`
-- run and the next `lease-details` run nulls them all over again.
--
-- WHAT THIS DOES. Clears `deep_synced_at` on the damaged rows, which is the only
-- thing making `unit-details` skip them. The dates are NOT written here — this
-- delta cannot invent them. It makes the rows eligible again; the next
-- `unit-details` run reads the lease-history table and restores the real values.
--
-- Cost of re-eligibility: those 192 leases get a full re-scrape (ledger, tabs,
-- residents) on the next pass instead of being skipped. That is the point.
--
-- ONLY start AND end BOTH NULL. A lease with one date is not this bug — the
-- synthetic row nulls the pair together. Restricting to the pair keeps the
-- statement from re-queueing rows for some other reason.
--
-- Idempotent: re-running after a successful `unit-details` pass matches nothing,
-- because the rows it targeted now have dates.
-- ============================================================================

update public.resman_leases
   set deep_synced_at = null
 where start_date is null
   and end_date is null
   and deep_synced_at is not null;
