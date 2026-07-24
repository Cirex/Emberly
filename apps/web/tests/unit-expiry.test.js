const assert = require("node:assert/strict");
const test = require("node:test");

const { conditionalRuleExpired, ruleExpired, resolveExpiry } = require("../lib/unit-expiry");

const rule = (over = {}) => ({
  expiryKind: "never",
  expiresAt: null,
  boundLeaseId: null,
  statusTrigger: null,
  ...over,
});
const ctx = (over = {}) => ({
  currentLeaseId: "lease-1",
  leaseStatus: "Current",
  occupancyStatus: "Occupied",
  ...over,
});

// ── move_out: the case that prompted this. A suspension belongs to the
// household that earned it, not to the door.

test("move_out survives while the bound lease is still the unit's current lease", () => {
  const r = rule({ expiryKind: "move_out", boundLeaseId: "lease-1" });
  assert.equal(conditionalRuleExpired(r, ctx()), false);
});

test("move_out expires once the unit has been re-leased", () => {
  const r = rule({ expiryKind: "move_out", boundLeaseId: "lease-1" });
  assert.equal(conditionalRuleExpired(r, ctx({ currentLeaseId: "lease-2" })), true);
});

test("move_out expires when the unit goes vacant", () => {
  const r = rule({ expiryKind: "move_out", boundLeaseId: "lease-1" });
  assert.equal(conditionalRuleExpired(r, ctx({ occupancyStatus: "Vacant" })), true);
});

test("move_out expires when the unit row is gone entirely", () => {
  const r = rule({ expiryKind: "move_out", boundLeaseId: "lease-1" });
  assert.equal(conditionalRuleExpired(r, undefined), true);
});

test("a unit on Notice is NOT yet moved out — the ban still holds", () => {
  // Notice means the lease is ending, not ended. Lifting here would restore
  // guest access to the very household that lost it.
  const r = rule({ expiryKind: "move_out", boundLeaseId: "lease-1" });
  assert.equal(conditionalRuleExpired(r, ctx({ occupancyStatus: "Notice" })), false);
});

// ── status_change

test("status_change holds while the lease keeps the watched status", () => {
  const r = rule({ expiryKind: "status_change", statusTrigger: "Under Eviction" });
  assert.equal(conditionalRuleExpired(r, ctx({ leaseStatus: "Under Eviction" })), false);
});

test("status_change expires once the lease leaves the watched status", () => {
  const r = rule({ expiryKind: "status_change", statusTrigger: "Under Eviction" });
  assert.equal(conditionalRuleExpired(r, ctx({ leaseStatus: "Current" })), true);
});

// ── time-based, via ruleExpired

test("a past expires_at is expired; a future one is not", () => {
  const past = rule({ expiryKind: "date", expiresAt: "2020-01-01T00:00:00.000Z" });
  const future = rule({ expiryKind: "date", expiresAt: "2999-01-01T00:00:00.000Z" });
  assert.equal(ruleExpired(past, ctx()), true);
  assert.equal(ruleExpired(future, ctx()), false);
});

test("never expires, whatever the unit's state", () => {
  assert.equal(ruleExpired(rule(), undefined), false);
  assert.equal(ruleExpired(rule(), ctx({ occupancyStatus: "Vacant" })), false);
});

// ── resolveExpiry snapshots the rule at creation

test("move_out binds to the unit's current lease", () => {
  assert.deepEqual(resolveExpiry({ kind: "move_out" }, ctx()), {
    expires_at: null,
    bound_lease_id: "lease-1",
    status_trigger: null,
  });
});

test("move_out is refused when there is no lease to bind to", () => {
  // Otherwise it would store as permanent and quietly never lift.
  assert.throws(() => resolveExpiry({ kind: "move_out" }, ctx({ currentLeaseId: null })));
  assert.throws(() => resolveExpiry({ kind: "move_out" }, undefined));
});

test("status_change snapshots the status being watched", () => {
  assert.deepEqual(resolveExpiry({ kind: "status_change" }, ctx({ leaseStatus: "Notice to Vacate" })), {
    expires_at: null,
    bound_lease_id: null,
    status_trigger: "Notice to Vacate",
  });
});

test("date resolves to end of the given day", () => {
  const out = resolveExpiry({ kind: "date", expiresOn: "2026-08-01" }, ctx());
  assert.equal(out.expires_at, "2026-08-01T23:59:59.000Z");
});

test("duration resolves to N days out", () => {
  const out = resolveExpiry({ kind: "duration", durationDays: 30 }, ctx());
  const days = Math.round((new Date(out.expires_at).getTime() - Date.now()) / 86_400_000);
  assert.equal(days, 30);
});

test("bad expiry input is rejected rather than silently stored", () => {
  assert.throws(() => resolveExpiry({ kind: "date" }, ctx()));
  assert.throws(() => resolveExpiry({ kind: "date", expiresOn: "not-a-date" }, ctx()));
  assert.throws(() => resolveExpiry({ kind: "duration", durationDays: 0 }, ctx()));
});

test("never stores no rule columns", () => {
  assert.deepEqual(resolveExpiry({ kind: "never" }, ctx()), {
    expires_at: null,
    bound_lease_id: null,
    status_trigger: null,
  });
});
