const assert = require("node:assert/strict");
const test = require("node:test");

// Pure module — no Supabase, no Next.js, so no bun:test mock.module harness is
// needed here (unlike tests/pm-tasks.test.js, which stubs the route's deps).
// This file still runs in its own process via the package.json `test` script.
const {
  ALERT_FRESHNESS_DAYS,
  BALANCE_REARM_RATIO,
  DEFAULT_BALANCE_THRESHOLD,
  MANAGER_ALERT_KINDS,
  MANAGER_ALERT_ROUTES,
  UTILITY_SPIKE_MIN_AMOUNT,
  UTILITY_SPIKE_RATIO,
  buildManagerAlert,
  detectApplicationReceived,
  detectBalanceThreshold,
  detectEvictionMilestones,
  detectLeaseSigned,
  detectManagerAlerts,
  detectUtilitySpikes,
  deviceWantsKind,
  emptyNotifiedMap,
  formatShortDate,
  formatUsd,
  isFresh,
  isManagerAlertKind,
  tokensForAlert,
  typicalUtilityCharges,
  unitLabel,
} = require("../lib/manager-alerts.ts");

const NOW = "2026-07-21T14:00:00.000Z";
const none = new Set();

// --- formatting -------------------------------------------------------------

test("formatUsd groups thousands and always shows cents", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(1500), "$1,500.00");
  assert.equal(formatUsd(1820.5), "$1,820.50");
  assert.equal(formatUsd(1234567.891), "$1,234,567.89");
  assert.equal(formatUsd(-42.5), "-$42.50");
});

test("formatShortDate renders an ISO day and tolerates junk", () => {
  assert.equal(formatShortDate("2026-07-18"), "Jul 18");
  assert.equal(formatShortDate("2026-01-01T09:30:00Z"), "Jan 1");
  assert.equal(formatShortDate(""), "");
  assert.equal(formatShortDate(null), "");
  assert.equal(formatShortDate("not a date"), "");
});

test("unitLabel falls back rather than rendering an empty phrase", () => {
  assert.equal(unitLabel("0644"), "Unit 0644");
  assert.equal(unitLabel(""), "Unassigned unit");
  assert.equal(unitLabel(null), "Unassigned unit");
});

test("isFresh bounds the cold-start burst to the freshness window", () => {
  assert.equal(isFresh("2026-07-20", NOW), true);
  assert.equal(isFresh("2026-07-07", NOW), true); // exactly 14 days
  assert.equal(isFresh("2026-07-06", NOW), false); // 15 days
  assert.equal(isFresh("2026-08-01", NOW), true); // future-dated rows still alert
  assert.equal(isFresh("", NOW), false);
  assert.equal(ALERT_FRESHNESS_DAYS, 14);
});

// --- copy builder -----------------------------------------------------------

test("copy is PII-light: no names, only units, dates, and amounts", () => {
  const built = [
    buildManagerAlert({
      kind: "application_received",
      unitNumber: "0644",
      leaseId: "l1",
      applicationDate: "2026-07-18",
    }),
    buildManagerAlert({
      kind: "lease_signed",
      unitNumber: "0644",
      leaseId: "l1",
      signedDate: "2026-07-19",
    }),
    buildManagerAlert({
      kind: "balance_threshold",
      unitNumber: "0644",
      unitId: "u1",
      balance: 1820.5,
      threshold: 1500,
    }),
    buildManagerAlert({
      kind: "eviction_milestone",
      unitNumber: "0644",
      actionId: "a1",
      milestone: "fed_filed",
      amount: 350,
    }),
    buildManagerAlert({
      kind: "utility_spike",
      unitNumber: "0644",
      billId: "b1",
      charges: 412.3,
      typical: 180,
    }),
  ];
  assert.deepEqual(
    built.map((a) => `${a.title} — ${a.body}`),
    [
      "Application received — Unit 0644 · Jul 18",
      "Lease signed — Unit 0644 · Jul 19",
      "Balance over $1,500.00 — Unit 0644 · balance $1,820.50",
      "FED filed — Unit 0644 · $350.00",
      "Utility spike — Unit 0644 · $412.30 vs $180.00 typical",
    ],
  );
});

test("eviction copy distinguishes the milestone and drops a missing amount", () => {
  const completed = buildManagerAlert({
    kind: "eviction_milestone",
    unitNumber: "12",
    actionId: "a2",
    milestone: "eviction_completed",
    amount: null,
  });
  assert.equal(completed.title, "Eviction completed");
  assert.equal(completed.body, "Unit 12");
  assert.equal(completed.amount, null);
});

test("every kind routes to its manager tab and carries the source id", () => {
  assert.deepEqual([...MANAGER_ALERT_KINDS], [
    "application_received",
    "lease_signed",
    "balance_threshold",
    "eviction_milestone",
    "utility_spike",
  ]);
  assert.deepEqual(MANAGER_ALERT_ROUTES, {
    application_received: "/(tabs)/leasing",
    lease_signed: "/(tabs)/leasing",
    balance_threshold: "/(tabs)/delinquency",
    eviction_milestone: "/(tabs)/delinquency",
    utility_spike: "/(tabs)/utilities",
  });
  const spike = buildManagerAlert({
    kind: "utility_spike",
    unitNumber: "7",
    billId: "bill-9",
    charges: 400,
    typical: 100,
  });
  assert.deepEqual(spike.data, { route: "/(tabs)/utilities", id: "bill-9" });
  assert.equal(spike.subjectKey, "bill-9");
});

test("isManagerAlertKind rejects anything not in the union", () => {
  assert.equal(isManagerAlertKind("lease_signed"), true);
  assert.equal(isManagerAlertKind("emergency"), false);
  assert.equal(isManagerAlertKind(7), false);
});

// --- application_received / lease_signed ------------------------------------

function lease(overrides = {}) {
  return {
    resman_lease_id: "lease-1",
    unit_number: "0644",
    application_date: "2026-07-19",
    signed_date: null,
    ...overrides,
  };
}

test("detectApplicationReceived fires once per fresh, unclaimed lease", () => {
  const alerts = detectApplicationReceived([lease()], none, { nowIso: NOW });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "application_received");
  assert.equal(alerts[0].subjectKey, "lease-1");
});

test("detectApplicationReceived skips claimed leases and stale application dates", () => {
  assert.deepEqual(detectApplicationReceived([lease()], new Set(["lease-1"]), { nowIso: NOW }), []);
  assert.deepEqual(
    detectApplicationReceived([lease({ application_date: "2026-01-02" })], none, { nowIso: NOW }),
    [],
  );
  assert.deepEqual(detectApplicationReceived([lease({ application_date: null })], none, { nowIso: NOW }), []);
});

test("detectLeaseSigned keys on signed_date, independent of the application alert", () => {
  const rows = [lease({ signed_date: "2026-07-20" })];
  assert.equal(detectLeaseSigned(rows, none, { nowIso: NOW }).length, 1);
  // Same lease, both kinds — the ledger is per (kind, subject), so a lease that
  // already alerted on application still alerts on signature.
  assert.equal(detectLeaseSigned(rows, new Set(["lease-1"]), { nowIso: NOW }).length, 0);
  assert.equal(detectLeaseSigned([lease()], none, { nowIso: NOW }).length, 0);
});

// --- balance_threshold ------------------------------------------------------

function unit(overrides = {}) {
  return { resman_unit_id: "unit-1", number: "0644", balance: 1600, ...overrides };
}

test("detectBalanceThreshold alerts on the default $1500 crossing", () => {
  assert.equal(DEFAULT_BALANCE_THRESHOLD, 1500);
  const { alerts } = detectBalanceThreshold([unit()], none);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, "Balance over $1,500.00");
  assert.equal(alerts[0].amount, 1600);
  assert.deepEqual(detectBalanceThreshold([unit({ balance: 1499.99 })], none).alerts, []);
  // Exactly at the threshold counts as crossed.
  assert.equal(detectBalanceThreshold([unit({ balance: 1500 })], none).alerts.length, 1);
});

test("detectBalanceThreshold honours a configured threshold", () => {
  const { alerts } = detectBalanceThreshold([unit({ balance: 900 })], none, { threshold: 750 });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, "Balance over $750.00");
  assert.deepEqual(detectBalanceThreshold([unit({ balance: 900 })], none, { threshold: 1000 }).alerts, []);
});

test("detectBalanceThreshold never re-fires while the unit stays claimed", () => {
  const claimed = new Set(["unit-1"]);
  const result = detectBalanceThreshold([unit({ balance: 2500 })], claimed);
  assert.deepEqual(result.alerts, []);
  assert.deepEqual(result.rearmedUnitIds, []);
});

test("detectBalanceThreshold re-arms only below the hysteresis band", () => {
  assert.equal(BALANCE_REARM_RATIO, 0.9);
  const claimed = new Set(["unit-1"]);
  // $1,400 is under the threshold but inside the band — still silent, still claimed.
  assert.deepEqual(detectBalanceThreshold([unit({ balance: 1400 })], claimed).rearmedUnitIds, []);
  // $1,300 is below 0.9 × 1500 — the claim is released.
  assert.deepEqual(detectBalanceThreshold([unit({ balance: 1300 })], claimed).rearmedUnitIds, [
    "unit-1",
  ]);
});

test("detectBalanceThreshold coerces string/null balances from PostgREST numerics", () => {
  assert.equal(detectBalanceThreshold([unit({ balance: "1820.50" })], none).alerts.length, 1);
  assert.deepEqual(detectBalanceThreshold([unit({ balance: null })], none).alerts, []);
});

// --- eviction_milestone -----------------------------------------------------

function action(overrides = {}) {
  return {
    id: "action-1",
    kind: "fed_filed",
    unit_number: "0644",
    amount: 350,
    created_at: "2026-07-20T10:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

test("detectEvictionMilestones only fires on fed_filed and eviction_completed", () => {
  const rows = [
    action({ id: "a", kind: "fed_filed" }),
    action({ id: "b", kind: "eviction_completed" }),
    action({ id: "c", kind: "notice_served" }),
    action({ id: "d", kind: "promise_broken" }),
  ];
  assert.deepEqual(
    detectEvictionMilestones(rows, none, { nowIso: NOW }).map((a) => a.subjectKey),
    ["a", "b"],
  );
});

test("detectEvictionMilestones ignores soft-deleted, claimed, and stale rows", () => {
  assert.deepEqual(
    detectEvictionMilestones([action({ deleted_at: "2026-07-21T00:00:00Z" })], none, { nowIso: NOW }),
    [],
  );
  assert.deepEqual(detectEvictionMilestones([action()], new Set(["action-1"]), { nowIso: NOW }), []);
  assert.deepEqual(
    detectEvictionMilestones([action({ created_at: "2026-05-01T00:00:00Z" })], none, { nowIso: NOW }),
    [],
  );
});

// --- utility_spike ----------------------------------------------------------

function bill(overrides = {}) {
  return {
    id: "bill-1",
    mlgw_account_id: "acct-1",
    bill_date: "2026-07-15",
    amount_due: 100,
    balance_forward: 0,
    ...overrides,
  };
}

const UNIT_ACCOUNT = { id: "acct-1", unit_number: "0644", is_house_account: false };
const HOUSE_ACCOUNT = { id: "acct-house", unit_number: "", is_house_account: true };

/** Six prior-month bills averaging $100 of new charges. */
function history() {
  return [
    bill({ id: "h1", bill_date: "2026-06-10", amount_due: 100 }),
    bill({ id: "h2", bill_date: "2026-05-10", amount_due: 100 }),
    bill({ id: "h3", bill_date: "2026-04-10", amount_due: 100 }),
  ];
}

test("typicalUtilityCharges averages new charges from months before the current one", () => {
  const bills = [...history(), bill({ id: "now", bill_date: "2026-07-15", amount_due: 9999 })];
  assert.equal(typicalUtilityCharges(bills, NOW), 100);
  // Balance forward is carried-over money, not this month's charges.
  assert.equal(
    typicalUtilityCharges([bill({ bill_date: "2026-06-01", amount_due: 150, balance_forward: 50 })], NOW),
    100,
  );
  assert.equal(typicalUtilityCharges([], NOW), 0);
});

test("detectUtilitySpikes flags charges at or above the ratio and the floor", () => {
  assert.equal(UTILITY_SPIKE_RATIO, 1.75);
  assert.equal(UTILITY_SPIKE_MIN_AMOUNT, 40);
  const bills = [...history(), bill({ id: "spike", amount_due: 175 })];
  const alerts = detectUtilitySpikes(bills, [UNIT_ACCOUNT], none, { nowIso: NOW });
  assert.deepEqual(alerts.map((a) => a.subjectKey), ["spike"]);
  assert.equal(alerts[0].body, "Unit 0644 · $175.00 vs $100.00 typical");

  const under = [...history(), bill({ id: "meh", amount_due: 174 })];
  assert.deepEqual(detectUtilitySpikes(under, [UNIT_ACCOUNT], none, { nowIso: NOW }), []);
});

test("detectUtilitySpikes ignores the dollar floor case, house meters, and stale bills", () => {
  // Ratio met but under the $40 floor: three $10 months, then a $30 bill.
  const tiny = [
    bill({ id: "t1", bill_date: "2026-06-10", amount_due: 10 }),
    bill({ id: "t2", bill_date: "2026-05-10", amount_due: 10 }),
    bill({ id: "small", amount_due: 30 }),
  ];
  assert.deepEqual(detectUtilitySpikes(tiny, [UNIT_ACCOUNT], none, { nowIso: NOW }), []);

  const house = [...history(), bill({ id: "master", mlgw_account_id: "acct-house", amount_due: 5000 })];
  assert.deepEqual(
    detectUtilitySpikes(house, [UNIT_ACCOUNT, HOUSE_ACCOUNT], none, { nowIso: NOW }),
    [],
  );

  const stale = [...history(), bill({ id: "old", bill_date: "2026-02-01", amount_due: 900 })];
  assert.deepEqual(detectUtilitySpikes(stale, [UNIT_ACCOUNT], none, { nowIso: NOW }), []);

  // No history at all → no denominator → never flag.
  assert.deepEqual(detectUtilitySpikes([bill({ amount_due: 900 })], [UNIT_ACCOUNT], none, { nowIso: NOW }), []);
});

test("detectUtilitySpikes skips bills already claimed in the ledger", () => {
  const bills = [...history(), bill({ id: "spike", amount_due: 400 })];
  assert.deepEqual(detectUtilitySpikes(bills, [UNIT_ACCOUNT], new Set(["spike"]), { nowIso: NOW }), []);
});

// --- the whole pass ---------------------------------------------------------

test("detectManagerAlerts runs every detector in kind order", () => {
  const pass = detectManagerAlerts({
    leases: [lease({ signed_date: "2026-07-20" })],
    units: [unit({ balance: 2000 })],
    delinquencyActions: [action()],
    utilityBills: [...history(), bill({ id: "spike", amount_due: 400 })],
    utilityAccounts: [UNIT_ACCOUNT],
    notified: emptyNotifiedMap(),
    nowIso: NOW,
  });
  assert.deepEqual(pass.alerts.map((a) => a.kind), [
    "application_received",
    "lease_signed",
    "balance_threshold",
    "eviction_milestone",
    "utility_spike",
  ]);
  assert.deepEqual(pass.rearmedUnitIds, []);
});

test("detectManagerAlerts is silent on a second pass once everything is claimed", () => {
  const input = {
    leases: [lease({ signed_date: "2026-07-20" })],
    units: [unit({ balance: 2000 })],
    delinquencyActions: [action()],
    utilityBills: [...history(), bill({ id: "spike", amount_due: 400 })],
    utilityAccounts: [UNIT_ACCOUNT],
    notified: emptyNotifiedMap(),
    nowIso: NOW,
  };
  const first = detectManagerAlerts(input);
  const notified = emptyNotifiedMap();
  for (const alert of first.alerts) notified[alert.kind] = new Set([alert.subjectKey]);
  const second = detectManagerAlerts({ ...input, notified });
  assert.deepEqual(second.alerts, []);
});

// --- per-device fan-out -----------------------------------------------------

test("an empty alertKinds list means the device wants everything", () => {
  const device = { expoPushToken: "tok", alertKinds: [] };
  for (const kind of MANAGER_ALERT_KINDS) assert.equal(deviceWantsKind(device, kind), true);
});

test("tokensForAlert filters by opt-in and drops blank tokens", () => {
  const devices = [
    { expoPushToken: "all", alertKinds: [] },
    { expoPushToken: "leasing-only", alertKinds: ["application_received", "lease_signed"] },
    { expoPushToken: "", alertKinds: [] },
  ];
  assert.deepEqual(tokensForAlert(devices, "lease_signed"), ["all", "leasing-only"]);
  assert.deepEqual(tokensForAlert(devices, "utility_spike"), ["all"]);
});
