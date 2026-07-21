const { test } = require("node:test");
const assert = require("node:assert");
const { LOW_VOLUME_THRESHOLD, buildAgentStats, EARLY_DEFAULT_MONTHS } = require("../dist");

const NOW = new Date(2026, 6, 21, 12).getTime(); // Jul 21 2026 local noon
const OPTS = { windowMonths: 12, nowMs: NOW };

function lease(fields = {}) {
  return { leasingAgent: "Ana", isCurrentLease: true, ...fields };
}

test("counts signed-in-window (applicationDate, moveInDate fallback), active, evictions", () => {
  const stats = buildAgentStats(
    [
      lease({ applicationDate: "2026-01-10", moveInDate: "2026-02-01" }), // in window
      lease({ applicationDate: "2024-01-10", isCurrentLease: false }), // out of window
      lease({ moveInDate: "2025-09-15" }), // no applicationDate: falls back to moveInDate, in window
      lease({ applicationDate: "2023-05-01", isCurrentLease: false, evicted: true }),
    ],
    OPTS,
  );
  assert.equal(stats.length, 1);
  const s = stats[0];
  assert.equal(s.agent, "Ana");
  assert.equal(s.leasesSigned, 2);
  assert.equal(s.active, 2);
  assert.equal(s.evictions, 1);
  assert.equal(s.evictionRate, 1 / 4); // over ALL leases attributed to the agent
  assert.equal(s.lowVolume, true); // 2 < LOW_VOLUME_THRESHOLD
  assert.ok(LOW_VOLUME_THRESHOLD === 12);
});

test("delinquency: count/balance from active leases, load over active rent sum", () => {
  const [s] = buildAgentStats(
    [
      lease({ balance: 600, residentRent: 1200 }),
      lease({ balance: 0, residentRent: 1000 }),
      lease({ balance: 400, residentRent: 800 }),
      lease({ balance: 999, residentRent: 1500, isCurrentLease: false }), // past lease: excluded
    ],
    OPTS,
  );
  assert.equal(s.delinquentCount, 2);
  assert.equal(s.delinquentBalance, 1000);
  assert.equal(s.delinquencyLoad, 1000 / 3000);
});

test("delinquencyLoad is 0-safe when no active rent", () => {
  const [s] = buildAgentStats([lease({ balance: 500, isCurrentLease: false })], OPTS);
  assert.equal(s.delinquencyLoad, 0);
  assert.equal(s.delinquentCount, 0);
});

test("earlyDefaultRate: first late month within 3 months of move-in", () => {
  const [s] = buildAgentStats(
    [
      lease({ moveInDate: "2026-01-05", firstLateMonth: "2026-03" }), // +2 months: early default
      lease({ moveInDate: "2026-01-05", firstLateMonth: "2026-04" }), // +3: still early (inclusive)
      lease({ moveInDate: "2025-06-01", firstLateMonth: "2026-01" }), // +7: not early
      lease({ moveInDate: "2025-06-01", firstLateMonth: null }), // never late
      lease({ firstLateMonth: "2026-01" }), // no moveInDate: excluded from denominator
    ],
    OPTS,
  );
  assert.equal(s.earlyDefaultRate, 2 / 4);
  assert.equal(EARLY_DEFAULT_MONTHS, 3);
});

test("blank agent names are skipped; sort is risk ascending then volume descending", () => {
  const inWindow = { applicationDate: "2026-05-01" };
  const stats = buildAgentStats(
    [
      // Rico: 2 leases, 1 evicted -> risky
      lease({ leasingAgent: "Rico", ...inWindow, evicted: true, isCurrentLease: false }),
      lease({ leasingAgent: "Rico", ...inWindow }),
      // Ana: clean, 2 signed
      lease({ leasingAgent: "Ana", ...inWindow }),
      lease({ leasingAgent: "Ana", ...inWindow }),
      // Bea: clean, 1 signed -> ties Ana on risk, fewer signed
      lease({ leasingAgent: "Bea", ...inWindow }),
      lease({ leasingAgent: "  " }), // blank: skipped
    ],
    OPTS,
  );
  assert.deepEqual(
    stats.map((s) => s.agent),
    ["Ana", "Bea", "Rico"],
  );
});
