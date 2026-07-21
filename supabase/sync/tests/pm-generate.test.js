const assert = require("node:assert/strict");
const test = require("node:test");

const {
  roundKeyFor,
  dueDateFor,
  periodStartMs,
  unitsInScope,
  generatePmTasks,
} = require("../src/pm/generate.ts");

// Local-time timestamps (the generator does all date math in local time).
const at = (year, month1, day) => new Date(year, month1 - 1, day, 12, 0, 0).getTime();

const unit = (number, overrides = {}) => ({
  number,
  resman_building_id: null,
  classification: "",
  excluded_from_occupancy: null,
  holding_unit: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Round-key math
// ---------------------------------------------------------------------------

test("monthly round key is the current local month; anchor is irrelevant", () => {
  assert.equal(roundKeyFor("monthly", null, at(2026, 7, 15)), "2026-07");
  assert.equal(roundKeyFor("monthly", 10, at(2026, 7, 15)), "2026-07");
  assert.equal(roundKeyFor("monthly", null, at(2026, 1, 1)), "2026-01");
  assert.equal(roundKeyFor("monthly", null, at(2026, 12, 31)), "2026-12");
});

test("quarterly anchor 4 keys off Apr/Jul/Oct/Jan period starts", () => {
  assert.equal(roundKeyFor("quarterly", 4, at(2026, 4, 1)), "2026-04"); // period start day
  assert.equal(roundKeyFor("quarterly", 4, at(2026, 5, 20)), "2026-04"); // mid-period
  assert.equal(roundKeyFor("quarterly", 4, at(2026, 6, 30)), "2026-04"); // last day
  assert.equal(roundKeyFor("quarterly", 4, at(2026, 7, 1)), "2026-07"); // next period
  assert.equal(roundKeyFor("quarterly", 4, at(2026, 11, 3)), "2026-10");
  assert.equal(roundKeyFor("quarterly", 4, at(2026, 2, 10)), "2026-01"); // Jan period
});

test("null anchor_month defaults to January", () => {
  assert.equal(roundKeyFor("quarterly", null, at(2026, 2, 10)), "2026-01");
  assert.equal(roundKeyFor("quarterly", null, at(2026, 8, 10)), "2026-07");
  assert.equal(roundKeyFor("semiannual", null, at(2026, 9, 1)), "2026-07");
  assert.equal(roundKeyFor("annual", null, at(2026, 7, 20)), "2026-01");
});

test("year wrap: anchor 10, now February -> period started previous October", () => {
  assert.equal(roundKeyFor("semiannual", 10, at(2026, 2, 15)), "2025-10");
  assert.equal(roundKeyFor("annual", 10, at(2026, 2, 15)), "2025-10");
  // and back inside the same calendar year once the anchor month arrives
  assert.equal(roundKeyFor("semiannual", 10, at(2026, 4, 1)), "2026-04");
  assert.equal(roundKeyFor("annual", 10, at(2026, 10, 1)), "2026-10");
  assert.equal(roundKeyFor("annual", 10, at(2026, 9, 30)), "2025-10");
});

test("semiannual anchor 4 covers both halves of the cycle", () => {
  assert.equal(roundKeyFor("semiannual", 4, at(2026, 4, 1)), "2026-04");
  assert.equal(roundKeyFor("semiannual", 4, at(2026, 9, 30)), "2026-04");
  assert.equal(roundKeyFor("semiannual", 4, at(2026, 10, 1)), "2026-10");
  assert.equal(roundKeyFor("semiannual", 4, at(2027, 3, 31)), "2026-10");
});

test("periodStartMs is the local first-of-month midnight of the period", () => {
  assert.equal(periodStartMs("quarterly", 4, at(2026, 5, 20)), new Date(2026, 3, 1).getTime());
  assert.equal(periodStartMs("annual", 10, at(2026, 2, 15)), new Date(2025, 9, 1).getTime());
});

test("unknown cadence throws loudly", () => {
  assert.throws(() => roundKeyFor("weekly", null, at(2026, 7, 15)), /Unknown PM cadence/);
});

// ---------------------------------------------------------------------------
// Due dates
// ---------------------------------------------------------------------------

test("due date is period start + 14 days, YYYY-MM-DD local", () => {
  assert.equal(dueDateFor("monthly", null, at(2026, 7, 20)), "2026-07-15");
  assert.equal(dueDateFor("monthly", null, at(2026, 2, 3)), "2026-02-15"); // zero-padded
  assert.equal(dueDateFor("quarterly", 4, at(2026, 5, 20)), "2026-04-15");
  assert.equal(dueDateFor("semiannual", 10, at(2026, 2, 15)), "2025-10-15"); // year wrap
});

// ---------------------------------------------------------------------------
// Scope matching
// ---------------------------------------------------------------------------

test("scope 'all' matches every unit but excludes flagged/blank units", () => {
  const units = [
    unit("101"),
    unit("102", { excluded_from_occupancy: true }),
    unit("103", { holding_unit: true }),
    unit("   "), // blank unit number
    unit("104", { excluded_from_occupancy: false, holding_unit: false }),
  ];
  const inScope = unitsInScope({ scope_type: "all", scope_values: [] }, units);
  assert.deepEqual(inScope.map((u) => u.number), ["101", "104"]);
});

test("scope 'classification' matches case-insensitively with trimming", () => {
  const units = [
    unit("101", { classification: "Senior" }),
    unit("102", { classification: " SENIOR " }),
    unit("103", { classification: "Family" }),
    unit("104", { classification: null }),
  ];
  const template = { scope_type: "classification", scope_values: ["senior"] };
  assert.deepEqual(unitsInScope(template, units).map((u) => u.number), ["101", "102"]);
});

test("scope 'building' matches by building NAME case-insensitively", () => {
  const buildings = [
    { resman_building_id: "b1", name: "Building A" },
    { resman_building_id: "b2", name: "Building B" },
  ];
  const units = [
    unit("101", { resman_building_id: "b1" }),
    unit("201", { resman_building_id: "b2" }),
    unit("301", { resman_building_id: "b-unknown" }), // id missing from mirror
    unit("401", { resman_building_id: null }), // no building
  ];
  const template = { scope_type: "building", scope_values: ["BUILDING a"] };
  assert.deepEqual(unitsInScope(template, units, buildings).map((u) => u.number), ["101"]);
});

test("a scoped template with empty scope_values matches nothing", () => {
  const units = [unit("101", { classification: "Senior" })];
  assert.deepEqual(unitsInScope({ scope_type: "classification", scope_values: [] }, units), []);
  assert.deepEqual(unitsInScope({ scope_type: "building", scope_values: null }, units, []), []);
});

// ---------------------------------------------------------------------------
// generatePmTasks
// ---------------------------------------------------------------------------

const TEMPLATE = {
  id: "t-1",
  name: "HVAC filters",
  cadence: "quarterly",
  anchor_month: 4,
  scope_type: "all",
  scope_values: [],
  active: true,
};

test("generatePmTasks expands active templates into the current round's rows", () => {
  const rows = generatePmTasks({
    templates: [TEMPLATE],
    units: [unit("102"), unit("101"), unit("103", { holding_unit: true })],
    buildings: [],
    nowMs: at(2026, 5, 20),
  });
  assert.deepEqual(rows, [
    { template_id: "t-1", round_key: "2026-04", unit_number: "101", due_date: "2026-04-15", status: "pending" },
    { template_id: "t-1", round_key: "2026-04", unit_number: "102", due_date: "2026-04-15", status: "pending" },
  ]);
});

test("inactive templates are skipped", () => {
  const rows = generatePmTasks({
    templates: [{ ...TEMPLATE, active: false }],
    units: [unit("101")],
    buildings: [],
    nowMs: at(2026, 5, 20),
  });
  assert.deepEqual(rows, []);
});

test("duplicate unit numbers collapse to one row per (template, round, unit)", () => {
  const rows = generatePmTasks({
    templates: [TEMPLATE],
    units: [unit("101", { resman_building_id: "b1" }), unit("101", { resman_building_id: "b2" })],
    buildings: [],
    nowMs: at(2026, 5, 20),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unit_number, "101");
});

test("output is deterministic and unit-order independent (idempotent input)", () => {
  const templates = [
    TEMPLATE,
    { ...TEMPLATE, id: "t-2", name: "Smoke detectors", cadence: "annual", anchor_month: 10, active: true },
  ];
  const buildings = [{ resman_building_id: "b1", name: "Building A" }];
  const units = [unit("103"), unit("101", { resman_building_id: "b1" }), unit("102")];
  const input = { templates, units, buildings, nowMs: at(2026, 2, 15) };
  const first = generatePmTasks(input);
  const second = generatePmTasks({ ...input, units: [...units].reverse() });
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((r) => `${r.template_id}|${r.round_key}|${r.unit_number}|${r.due_date}`),
    [
      "t-1|2026-01|101|2026-01-15",
      "t-1|2026-01|102|2026-01-15",
      "t-1|2026-01|103|2026-01-15",
      "t-2|2025-10|101|2025-10-15",
      "t-2|2025-10|102|2025-10-15",
      "t-2|2025-10|103|2025-10-15",
    ],
  );
});
