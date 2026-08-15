const { test } = require("node:test");
const assert = require("node:assert");
const { RENEWAL_MIN_GAP_DAYS, buildAgentStats, isRenewalLease } = require("../dist");

const NOW = new Date(2026, 6, 21, 12).getTime(); // Jul 21 2026 local noon
const OPTS = { windowMonths: 12, nowMs: NOW };

const lease = (fields = {}) => ({ leasingAgent: "Ana", isCurrentLease: true, ...fields });

/**
 * Move-ins and renewals are different work with different outcomes, and the
 * scorecard blended them.
 *
 * A move-in is the agent's own screening decision. A renewal is a resident
 * somebody else placed, whom this agent chose to keep. Measured across the
 * property's 516 active leases the two behave nothing alike: move-ins run 34%
 * delinquent at $1,123 average ($114.5k owed), renewals 24% at $567 ($29.5k).
 * A single blended load therefore tracked an agent's renewal SHARE more than
 * their judgement.
 *
 * The mirror has no renewal flag, but it does not need one: ResMan carries
 * `move_in_date` forward across renewals while `start_date` advances, so the
 * gap between them separates the two cleanly. Of 1,042 leases carrying both
 * dates, 653 start within a day of move-in and 379 start 200+ days after —
 * only 10 sit anywhere between, so a 31-day threshold has a month of slack
 * around anything real.
 */

test("a new tenancy starts the day the resident moves in", () => {
  assert.equal(isRenewalLease({ startDate: "2026-02-01", moveInDate: "2026-02-01" }), false);
  // Keys a day either side of the paperwork is still one move-in.
  assert.equal(isRenewalLease({ startDate: "2026-02-02", moveInDate: "2026-02-01" }), false);
  assert.equal(isRenewalLease({ startDate: "2026-01-31", moveInDate: "2026-02-01" }), false);
});

test("a renewal's term starts a year on from a move-in that never changed", () => {
  assert.equal(isRenewalLease({ startDate: "2027-02-01", moveInDate: "2026-02-01" }), true);
  assert.equal(isRenewalLease({ startDate: "2029-06-01", moveInDate: "2021-03-15" }), true);
});

test("the threshold sits in the empty gap between the two populations", () => {
  const moveIn = "2026-02-01";
  const dayAfter = (days) => {
    const d = new Date(2026, 1, 1 + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  assert.equal(isRenewalLease({ startDate: dayAfter(RENEWAL_MIN_GAP_DAYS), moveInDate: moveIn }), false);
  assert.equal(isRenewalLease({ startDate: dayAfter(RENEWAL_MIN_GAP_DAYS + 1), moveInDate: moveIn }), true);
});

test("a missing date is treated as a move-in, not a renewal", () => {
  // The conservative side: an unknown lease counts against the agent's own
  // screening rather than being excused as someone else's resident.
  assert.equal(isRenewalLease({ startDate: null, moveInDate: "2026-02-01" }), false);
  assert.equal(isRenewalLease({ startDate: "2026-02-01", moveInDate: null }), false);
  assert.equal(isRenewalLease({}), false);
});

test("delinquency is reported per kind, and the two still sum to the blended figure", () => {
  const [s] = buildAgentStats(
    [
      lease({ balance: 900, residentRent: 1000, isRenewal: false }),
      lease({ balance: 0, residentRent: 1000, isRenewal: false }),
      lease({ balance: 300, residentRent: 1200, isRenewal: true }),
      lease({ balance: 0, residentRent: 800, isRenewal: true }),
    ],
    OPTS,
  );

  assert.equal(s.moveIn.active, 2);
  assert.equal(s.moveIn.delinquentCount, 1);
  assert.equal(s.moveIn.delinquentBalance, 900);
  assert.equal(s.moveIn.delinquencyLoad, 900 / 2000);

  assert.equal(s.renewal.active, 2);
  assert.equal(s.renewal.delinquentCount, 1);
  assert.equal(s.renewal.delinquentBalance, 300);
  assert.equal(s.renewal.delinquencyLoad, 300 / 2000);

  // The blended numbers are unchanged — this adds detail, it does not restate
  // the total, so any existing figure a manager has seen still reconciles.
  assert.equal(s.delinquentCount, 2);
  assert.equal(s.delinquentBalance, 1200);
  assert.equal(s.delinquencyLoad, 1200 / 4000);
  assert.equal(s.moveIn.delinquentBalance + s.renewal.delinquentBalance, s.delinquentBalance);
});

test("an agent who only renews shows no move-in load rather than a flattering 0%", () => {
  const [s] = buildAgentStats([lease({ balance: 500, residentRent: 1000, isRenewal: true })], OPTS);
  assert.equal(s.moveIn.active, 0);
  assert.equal(s.moveIn.delinquencyLoad, 0, "0 with an active count of 0 means 'no book', not 'clean book'");
  assert.equal(s.renewal.delinquencyLoad, 0.5);
});

test("leases with no isRenewal flag all land on the move-in side", () => {
  // Callers that have not been updated keep their existing meaning.
  const [s] = buildAgentStats([lease({ balance: 100, residentRent: 1000 })], OPTS);
  assert.equal(s.moveIn.active, 1);
  assert.equal(s.renewal.active, 0);
});

test("signed-in-window counts are split too", () => {
  const [s] = buildAgentStats(
    [
      lease({ applicationDate: "2026-03-01", isRenewal: false }),
      lease({ applicationDate: "2026-04-01", isRenewal: true }),
      lease({ applicationDate: "2020-01-01", isRenewal: true }), // outside the window
    ],
    OPTS,
  );
  assert.equal(s.leasesSigned, 2);
  assert.equal(s.moveIn.signed, 1);
  assert.equal(s.renewal.signed, 1);
  assert.equal(s.renewal.total, 2, "total is all-time, unlike signed");
});

test("a renewal cannot be an early default — it is out of the denominator entirely", () => {
  // A renewal's move-in date is the ORIGINAL one, often years back, so it
  // could never fall inside the 3-month window. Counting it still diluted the
  // rate: this agent placed one move-in, who defaulted early.
  const leases = [
    lease({ moveInDate: "2026-05-01", firstLateMonth: "2026-06", isRenewal: false }),
    lease({ moveInDate: "2019-01-01", firstLateMonth: "2026-06", isRenewal: true }),
    lease({ moveInDate: "2018-01-01", firstLateMonth: "2026-05", isRenewal: true }),
  ];
  const [s] = buildAgentStats(leases, OPTS);
  assert.equal(s.earlyDefaultRate, 1, "1 of 1 move-ins, not 1 of 3 leases");
});

/**
 * A renewal has no application date — nobody applied, they already live there
 * — so the signing date fell through to the move-in date, which on a renewal
 * is the ORIGINAL one.
 *
 * Real case: unit 1732 ST-2, resident since 2020-07-20, renewed 2026-07-01 by
 * an agent who had been at the property about three months. The renewal was
 * dated 2020, so it fell outside every signing window and never counted as
 * work she did — while the balance that accrued on it did count against her.
 */
test("a renewal is signed when its TERM began, not when the resident first moved in", () => {
  const [s] = buildAgentStats(
    [
      lease({
        applicationDate: null,
        startDate: "2026-07-01",
        moveInDate: "2020-07-20",
        isRenewal: true,
      }),
    ],
    OPTS,
  );
  assert.equal(s.leasesSigned, 1, "signed July 2026, inside a 12-month window ending July 2026");
  assert.equal(s.renewal.signed, 1);
});

test("the old move-in fallback would have dated that lease six years early", () => {
  // Same lease with only the move-in date: outside the window, uncounted.
  const [s] = buildAgentStats(
    [lease({ applicationDate: null, startDate: null, moveInDate: "2020-07-20", isRenewal: true })],
    OPTS,
  );
  assert.equal(s.leasesSigned, 0);
});

test("an application date still wins, and a new move-in is unaffected", () => {
  // On a new tenancy startDate and moveInDate are the same day, so adding the
  // fallback cannot move anything that was already right.
  const [withApp] = buildAgentStats(
    [lease({ applicationDate: "2026-05-11", startDate: "2026-05-29", moveInDate: "2026-05-29" })],
    OPTS,
  );
  assert.equal(withApp.leasesSigned, 1);
  const [noApp] = buildAgentStats(
    [lease({ applicationDate: null, startDate: "2026-05-29", moveInDate: "2026-05-29" })],
    OPTS,
  );
  assert.equal(noApp.leasesSigned, 1);
});
