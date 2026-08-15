const assert = require("node:assert/strict");
const test = require("node:test");

const {
  leaseBalanceFromLedger,
  withoutBalance,
  withoutTermDates,
} = require("../src/resman/scrapers/leases");

/**
 * Where a lease's balance comes from, and who is allowed to write it.
 *
 * `mapLease` read the balance from the detail page's `Balance` field. That
 * field is not on the page, so every deep scrape wrote null and ALL 1,252
 * leases in the mirror carried a null balance. The delinquency view hid it by
 * falling back to `unit.balance` for current leases, which left every ended
 * tenancy reporting an open balance of zero and understated bad debt on the
 * agent P&L.
 *
 * The ledger has the answer and is already scraped: each entry carries the
 * running balance after it, and the newest entry's balance IS the lease
 * balance. Verified against the four largest debtors — the last entry matched
 * resman_units.balance to the cent, while summing charges minus credits was
 * $300 out on three of them.
 */

const entry = (seq, balance) => ({ ledger_sequence: seq, balance });

test("the NEWEST entry wins, not the last one in the array", () => {
  // mapLedgerRows assigns `rows.length - 1 - index`, so the newest entry has
  // the HIGHEST sequence and is first in the array. Order must not be assumed.
  assert.equal(leaseBalanceFromLedger([entry(2, 500), entry(1, 300), entry(0, 100)]), 500);
  assert.equal(leaseBalanceFromLedger([entry(0, 100), entry(1, 300), entry(2, 500)]), 500);
});

test("dates tie but sequences do not — sequence is the only ordering", () => {
  // Several entries routinely share one date; that is exactly why
  // ledger_sequence exists and why the balance column reads correctly by it.
  const sameDay = [entry(7, 1200.5), entry(8, 950.25), entry(6, 1400)];
  assert.equal(leaseBalanceFromLedger(sameDay), 950.25);
});

test("no ledger is a balance of ZERO, never null", () => {
  // No money has ever moved on the lease. That is a known zero, not unknown —
  // every lease has a balance.
  assert.equal(leaseBalanceFromLedger([]), 0);
});

test("a newest entry with a null balance still yields zero, not null", () => {
  assert.equal(leaseBalanceFromLedger([entry(3, null), entry(1, 400)]), 0);
});

test("a credit balance survives as negative — it is not clamped here", () => {
  // Clamping belongs to the view (delinquency clamps at >= 0). The mirror
  // records what ResMan says, including a resident in credit.
  assert.equal(leaseBalanceFromLedger([entry(5, -125.4)]), -125.4);
});

test("withoutBalance drops ONLY balance, leaving the rest of the row intact", () => {
  const row = {
    resman_lease_id: "L1", status: "Current", balance: 42,
    start_date: "2026-01-01", end_date: "2026-12-31", market_rent: 1200,
  };
  const stripped = withoutBalance(row);
  assert.equal("balance" in stripped, false, "balance must not reach the shallow upsert");
  assert.equal(stripped.status, "Current");
  assert.equal(stripped.market_rent, 1200);
  // The shallow pass still writes term dates — that strip belongs to the OTHER
  // pass, and confusing the two is how each column got wiped in turn.
  assert.equal(stripped.start_date, "2026-01-01");
  assert.equal(stripped.end_date, "2026-12-31");
});

test("the two strips are independent and compose", () => {
  const row = { resman_lease_id: "L1", balance: 9, start_date: "a", end_date: "b", status: "Former" };
  const both = withoutBalance(withoutTermDates(row));
  assert.deepEqual(Object.keys(both).sort(), ["resman_lease_id", "status"]);
});
