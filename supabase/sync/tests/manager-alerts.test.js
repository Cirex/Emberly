const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const { buildManagerPushMessages } = require("../src/manager/alerts.ts");
const { buildManagerAlert, MANAGER_ALERT_KINDS } = require("../src/manager/alert-rules.ts");

// ---------------------------------------------------------------------------
// Mirror guard. src/manager/alert-rules.ts is a checked copy of
// apps/web/lib/manager-alerts.ts (the sync tsconfig pins rootDir: src, so the
// worker cannot import across apps/). This test is what keeps them honest.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "../../..");

test("alert-rules.ts is byte-identical to apps/web/lib/manager-alerts.ts", () => {
  const mirror = fs.readFileSync(path.join(__dirname, "../src/manager/alert-rules.ts"), "utf8");
  const canonical = fs.readFileSync(
    path.join(REPO_ROOT, "apps/web/lib/manager-alerts.ts"),
    "utf8",
  );
  assert.equal(
    mirror,
    canonical,
    "supabase/sync/src/manager/alert-rules.ts has drifted from apps/web/lib/manager-alerts.ts — " +
      "re-copy the canonical file over the mirror",
  );
});

// ---------------------------------------------------------------------------
// Per-device fan-out — the part that decides which phones get which alert.
// ---------------------------------------------------------------------------

function alert(kind = "lease_signed") {
  return buildManagerAlert(
    kind === "lease_signed"
      ? { kind, unitNumber: "0644", leaseId: "lease-1", signedDate: "2026-07-18" }
      : { kind, unitNumber: "0644", unitId: "unit-1", balance: 1820.5, threshold: 1500 },
  );
}

test("buildManagerPushMessages addresses one message per subscribed device", () => {
  const devices = [
    { expoPushToken: "tok-all", alertKinds: [] },
    { expoPushToken: "tok-leasing", alertKinds: ["lease_signed", "application_received"] },
    { expoPushToken: "tok-balances", alertKinds: ["balance_threshold"] },
  ];
  const messages = buildManagerPushMessages(alert("lease_signed"), devices);
  assert.deepEqual(
    messages.map((m) => m.to),
    ["tok-all", "tok-leasing"],
  );
});

test("buildManagerPushMessages carries the route, kind, and id for tap handling", () => {
  const messages = buildManagerPushMessages(alert("balance_threshold"), [
    { expoPushToken: "tok-all", alertKinds: [] },
  ]);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    to: "tok-all",
    title: "Balance over $1,500.00",
    body: "Unit 0644 · balance $1,820.50",
    sound: "default",
    priority: "high",
    data: { route: "/(tabs)/delinquency", kind: "balance_threshold", id: "unit-1" },
  });
});

test("buildManagerPushMessages sends nothing when every device opted out", () => {
  const messages = buildManagerPushMessages(alert("lease_signed"), [
    { expoPushToken: "tok-balances", alertKinds: ["balance_threshold"] },
  ]);
  assert.deepEqual(messages, []);
});

test("every alert kind maps to a manager tab route", () => {
  const contexts = {
    application_received: { unitNumber: "1", leaseId: "l", applicationDate: "2026-07-18" },
    lease_signed: { unitNumber: "1", leaseId: "l", signedDate: "2026-07-18" },
    balance_threshold: { unitNumber: "1", unitId: "u", balance: 1600, threshold: 1500 },
    eviction_milestone: { unitNumber: "1", actionId: "a", milestone: "fed_filed", amount: null },
    utility_spike: { unitNumber: "1", billId: "b", charges: 400, typical: 180 },
    renewal_offer_silent: { unitNumber: "1", offerId: "o", daysSilent: 11 },
    policy_lapsed: { unitNumber: "1", policyId: "p", provider: "Acme Mutual" },
  };
  const routes = new Set(["/(tabs)/leasing", "/(tabs)/delinquency", "/(tabs)/utilities"]);
  assert.equal(MANAGER_ALERT_KINDS.length, Object.keys(contexts).length);
  for (const kind of MANAGER_ALERT_KINDS) {
    assert.ok(contexts[kind], `${kind} has no test context`);
    const built = buildManagerAlert({ kind, ...contexts[kind] });
    assert.ok(routes.has(built.data.route), `${kind} has no manager route`);
  }
});

test("the new kinds honour per-device opt-ins like the original five", () => {
  const silent = buildManagerAlert({
    kind: "renewal_offer_silent",
    unitNumber: "0433",
    offerId: "offer-1",
    daysSilent: 11,
  });
  const lapsed = buildManagerAlert({
    kind: "policy_lapsed",
    unitNumber: "0731",
    policyId: "ins-1",
    provider: "State Farm",
  });
  const devices = [
    { expoPushToken: "tok-all", alertKinds: [] },
    { expoPushToken: "tok-renewals", alertKinds: ["renewal_offer_silent"] },
    { expoPushToken: "tok-balances", alertKinds: ["balance_threshold"] },
  ];
  assert.deepEqual(
    buildManagerPushMessages(silent, devices).map((m) => m.to),
    ["tok-all", "tok-renewals"],
  );
  const lapsedMessages = buildManagerPushMessages(lapsed, devices);
  assert.deepEqual(lapsedMessages.map((m) => m.to), ["tok-all"]);
  assert.deepEqual(lapsedMessages[0], {
    to: "tok-all",
    title: "Renter's insurance lapsed",
    body: "Unit 0731 · State Farm",
    sound: "default",
    priority: "high",
    data: { route: "/(tabs)/leasing", kind: "policy_lapsed", id: "ins-1" },
  });
});
