const assert = require("node:assert/strict");
const test = require("node:test");

const fs = require("node:fs");
const path = require("node:path");

const {
  leaseBalanceFromLedger,
  withoutBalance,
  withoutTermDates,
} = require("../src/resman/scrapers/leases");
const { flFvPairs } = require("../src/resman/scrapers/parse");

const UNIT_DETAIL_SCRAPER = path.join(__dirname, "..", "src", "resman", "scrapers", "unit-detail.ts");

/**
 * The resident page's Balance box, exactly as the server sends it. Captured
 * from /Residents/Detail/c196d2d3-… (1833 WX-4, a resident who owes
 * $8,165.75). The boxes are present and correctly labelled; the values are
 * empty because ResMan fills this table with JavaScript — which is why a
 * browser's Inspect panel shows `class="fv red">8,165.75<` and View Source
 * does not.
 */
const BALANCES_TABLE_AS_SERVED = `
<td id="BalancesCell"><table id="BalancesTable"><tbody><tr>
<td id="HeaderBalance"><div class="fl">Balance</div><div id="Balance" class="fv"> </div></td>
<td id="HeaderDeposits" style="display:none;"><div class="fl">Deposits</div><div id="DepositBalance" class="fv"> </div></td>
<td id="HeaderCollection" style="display:none;"><div class="fl">Collection</div><div id="Collection" class="fv"> </div></td>
</tr></tbody></table></td>`;

test("the server sends the Balance box EMPTY — there is nothing to parse", () => {
  const fields = flFvPairs(BALANCES_TABLE_AS_SERVED);
  assert.equal(fields["Balance"], undefined);
  assert.equal(fields["Collection"], undefined);
  assert.equal(fields["Deposits"], undefined);
});

test("flFvPairs WOULD read it if ResMan ever served the value — so the gap is the page, not the parser", () => {
  // Same markup with the post-JavaScript value and its `red` class. If a future
  // ResMan release renders server-side, this is the line that starts passing
  // and the scraper can go back to reading the page directly.
  const filled = BALANCES_TABLE_AS_SERVED.replace(
    '<div id="Balance" class="fv"> </div>',
    '<div id="Balance" class="fv red">8,165.75</div>',
  );
  assert.equal(flFvPairs(filled)["Balance"], "8,165.75");
});

test("scrapeLease does not read Balance or Collection off the page", () => {
  // It looks readable — the labels are right there — so the dead read is easy
  // to reintroduce. It cannot work, and it silently nulled 1,252 leases.
  const source = fs.readFileSync(UNIT_DETAIL_SCRAPER, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.doesNotMatch(source, /fields\["Balance"\]/);
  assert.doesNotMatch(source, /fields\["Collection"\]/);
});

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

// ── The same bug, other columns ─────────────────────────────────────────────

/**
 * An audit of every mirrored column for the balance signature — 100% empty
 * across the whole table — turned up four more on resman_leases. Each was
 * triaged against the live page rather than assumed:
 *
 *   notice_given_date  RECOVERABLE. `for="NoticeGivenDate"` holds the value
 *                      (verified "7/31/2026" on 1732 ST-4). Its fl/fv label is
 *                      not standalone — the Vacating Information block packs
 *                      several labels into one `fl` div, so flFvPairs returns
 *                      the whole run as one mangled key and `fields["NTV
 *                      date"]` never exists. Fixed with the labelForValue
 *                      fallback the other three dates already use.
 *   renewal_date       NOT on the page — no `for="RenewalDate"` node, checked
 *                      against a Pending Renewal lease.
 *   collection_balance JS-rendered, like balance.
 *   monthly_charge     the mapper reads leaseData["monthlyCharge"], which NO
 *                      scraper ever assigns. A key with no producer.
 *
 * hap_rent is 97.3% empty but NOT this bug: the other 2.7% prove the read
 * works, and only HAP residents have one.
 */

test("the NTV date is read through labelForValue, not the mangled fl/fv label", () => {
  const source = fs.readFileSync(UNIT_DETAIL_SCRAPER, "utf8");
  assert.match(source, /labelForValue\("NoticeGivenDate", primaryHTML\)/);
});

test("flFvPairs really does mangle the Vacating Information block", () => {
  // Reproduces the shape from the live page: one `fl` div holding several
  // labels, so "NTV date" can never be a key on its own.
  const html = `
    <div class="fl">Application date 9/9/2025 Lease signed date Move-in date 9/12/2025 NTV date</div>
    <div class="fv">7/31/2026</div>`;
  const fields = flFvPairs(html);
  assert.equal(fields["NTV date"], undefined, "this is why the fallback is required");
  assert.ok(Object.keys(fields).some((k) => k.includes("NTV date")), "it is swallowed by a longer key");
});
