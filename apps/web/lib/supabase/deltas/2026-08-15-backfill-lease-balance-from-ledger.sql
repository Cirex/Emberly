-- Backfill resman_leases.balance from the ledger.
--
-- Every one of the 1,252 leases in the mirror carried a NULL balance. mapLease
-- read the value from the lease detail page's `Balance` field, and that field
-- is not on the page, so each deep scrape wrote null; the shallow pass, which
-- never sees a balance at all, wrote null over it again. The delinquency view
-- hid this by falling back to resman_units.balance for CURRENT leases, which
-- left every ended tenancy reporting an open balance of zero and understated
-- the bad-debt figures on the agent P&L.
--
-- resman_transactions already holds the answer: each entry carries the running
-- balance after it, and ledger_sequence (assigned newest-highest by
-- mapLedgerRows) is the only reliable ordering — dates tie, and several entries
-- routinely share one. Checked against the four largest debtors, the newest
-- entry matched resman_units.balance to the cent (8165.75, 6640.20, 6349.40,
-- 6238.20); summing charges minus credits was $300 out on three of them.
--
-- The sync now writes this on every deep scrape, but that would leave the
-- mirror wrong until each lease is next read. This fixes it in place, from data
-- already present, with no scraping.
--
-- A lease with no ledger has had no money move on it: that is a balance of
-- zero, not unknown. Both branches below are therefore deliberate.

with newest as (
  select distinct on (resman_lease_id)
    resman_lease_id,
    balance
  from public.resman_transactions
  where resman_lease_id is not null
  order by resman_lease_id, ledger_sequence desc
)
update public.resman_leases as l
set balance = coalesce(n.balance, 0)
from newest as n
where l.resman_lease_id = n.resman_lease_id
  and l.balance is distinct from coalesce(n.balance, 0);

-- Leases with no ledger rows at all: an explicit, known zero.
update public.resman_leases
set balance = 0
where balance is null;
