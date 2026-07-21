const { test } = require("node:test");
const assert = require("node:assert");
const { buildGroupPaint, defaultMapFilterGroups, strokeFor, unitMatchesGroup } = require("../dist");

const NOW = new Date(2026, 6, 21, 12).getTime(); // Jul 21 2026 local noon

function unit(fields = {}) {
  return { number: "101", occupancy_status: "Occupied", lease_status: "Current", balance: 0, ...fields };
}

test("conditions AND together; empty condition set matches nothing", () => {
  const delinquent = defaultMapFilterGroups()[0]; // balance>0 AND Occupied
  assert.equal(unitMatchesGroup(unit({ balance: 50 }), delinquent, NOW), true);
  assert.equal(unitMatchesGroup(unit({ balance: 0 }), delinquent, NOW), false);
  assert.equal(unitMatchesGroup(unit({ balance: 50, occupancy_status: "Vacant" }), delinquent, NOW), false);
  const empty = { id: "e", name: "E", colorHex: "#112233", conditions: [], visible: true };
  assert.equal(unitMatchesGroup(unit(), empty, NOW), false);
});

test("leaseEndsWithin parses date-only strings as local midnight", () => {
  const g = { id: "l", name: "L", colorHex: "#EF9F27", conditions: [{ kind: "leaseEndsWithin", days: 30 }], visible: true };
  assert.equal(unitMatchesGroup(unit({ lease_end_date: "2026-07-25" }), g, NOW), true);
  assert.equal(unitMatchesGroup(unit({ lease_end_date: "2026-09-25" }), g, NOW), false);
  assert.equal(unitMatchesGroup(unit({ lease_end_date: null }), g, NOW), false);
});

test("first visible group wins the paint; counts include hidden groups", () => {
  const groups = [
    { id: "a", name: "A", colorHex: "#E24B4A", conditions: [{ kind: "occupancy", value: "Occupied" }], visible: false },
    { id: "b", name: "B", colorHex: "#378ADD", conditions: [{ kind: "occupancy", value: "Occupied" }], visible: true },
  ];
  const { colorMap, counts } = buildGroupPaint(groups, [unit()], NOW);
  assert.equal(colorMap.get("101").fill, "#378ADD"); // hidden A skipped for paint
  assert.equal(counts.get("a"), 1); // ...but still counted
  assert.equal(counts.get("b"), 1);
});

test("strokeFor darkens the fill", () => {
  assert.equal(strokeFor("#ffffff"), "#b8b8b8");
  assert.equal(strokeFor("bogus"), "bogus");
});

function groupWith(cond) {
  return { id: "x", name: "X", colorHex: "#112233", conditions: [cond], visible: true };
}

test("availabilityIn matches case-insensitively and trimmed", () => {
  const g = groupWith({ kind: "availabilityIn", values: ["Available", "Leased - Not Yet Moved In"] });
  assert.equal(unitMatchesGroup(unit({ availability: "available" }), g, NOW), true);
  assert.equal(unitMatchesGroup(unit({ availability: "  AVAILABLE  " }), g, NOW), true);
  assert.equal(unitMatchesGroup(unit({ availability: "Unavailable" }), g, NOW), false);
  assert.equal(unitMatchesGroup(unit({ availability: null }), g, NOW), false);
  assert.equal(unitMatchesGroup(unit(), g, NOW), false);
});

test("evictionFlag matches delinquency_reason or evict-ish statuses", () => {
  const g = groupWith({ kind: "evictionFlag" });
  assert.equal(unitMatchesGroup(unit({ delinquency_reason: "Skip/Evict" }), g, NOW), true);
  assert.equal(unitMatchesGroup(unit({ delinquency_reason: "   " }), g, NOW), false); // whitespace-only is empty
  assert.equal(unitMatchesGroup(unit({ occupancy_status: "Occupied - EVICTION filed" }), g, NOW), true);
  assert.equal(unitMatchesGroup(unit({ lease_status: "Under Eviction" }), g, NOW), true); // lease_status carries it in ResMan
  assert.equal(unitMatchesGroup(unit(), g, NOW), false);
});

test("balanceBand is exclusive-min, inclusive-max; null max is unbounded", () => {
  const band = groupWith({ kind: "balanceBand", min: 300, max: 800 });
  assert.equal(unitMatchesGroup(unit({ balance: 300 }), band, NOW), false);
  assert.equal(unitMatchesGroup(unit({ balance: 300.01 }), band, NOW), true);
  assert.equal(unitMatchesGroup(unit({ balance: 800 }), band, NOW), true);
  assert.equal(unitMatchesGroup(unit({ balance: 801 }), band, NOW), false);
  assert.equal(unitMatchesGroup(unit({ balance: null }), band, NOW), false);
  const open = groupWith({ kind: "balanceBand", min: 1500, max: null });
  assert.equal(unitMatchesGroup(unit({ balance: 99999 }), open, NOW), true);
  assert.equal(unitMatchesGroup(unit({ balance: 1500 }), open, NOW), false);
});

test("defaultMapFilterGroups is unchanged by the new condition kinds", () => {
  assert.deepEqual(
    defaultMapFilterGroups().map((g) => g.id),
    ["prebuilt-delinquent", "prebuilt-lease-ending", "prebuilt-vacant"],
  );
});
