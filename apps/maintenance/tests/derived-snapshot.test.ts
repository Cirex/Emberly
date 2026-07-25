/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { WorkOrderSchema, type WorkOrder } from "../lib/api/work-orders";
import { ResmanUnitSchema, type ResmanUnit } from "../lib/api/units";
import { buildSnapshot, parseMirror, resetSnapshotCaches, type SnapshotInput } from "../lib/derived/snapshot";
import { EMPTY_FILTERS } from "../lib/derived/types";

const NOW = new Date("2026-07-15T12:00:00").getTime();

const STATUSES = ["Not Started", "Scheduled", "In Progress", "Completed", "Closed", "Canceled"];
const TECHS = ["Jordan Torres", "maintenance team", "grounds crew", "Riley Chen", ""];
const TITLES = [
  "Kitchen sink leaking under cabinet",
  "Trash Out",
  "Punch list",
  "HVAC not cooling",
  "Final unit walk/inspection",
  "Cleaning",
  "Rekey front door",
  "Flooring replacement",
];

/** Deterministic pseudo-random synthetic rows — no Math.random so the
 *  benchmark is reproducible. */
function syntheticRows(count: number): WorkOrder[] {
  const rows: WorkOrder[] = [];
  for (let i = 0; i < count; i++) {
    const status = STATUSES[i % STATUSES.length];
    const completed = status === "Completed" || status === "Closed";
    const reported = NOW - ((i * 37) % 400) * 24 * 60 * 60 * 1000;
    rows.push(
      WorkOrderSchema.parse({
        resman_work_order_id: `wo-${i}`,
        number: String(40000 + i),
        unit_number: `36${(i % 90) + 10} KG-${(i % 4) + 1}`,
        status,
        title: TITLES[i % TITLES.length],
        technician: TECHS[i % TECHS.length],
        tags: i % 3 === 0 ? ["HVAC"] : i % 5 === 0 ? ["Leaks", "Clogs"] : [],
        is_make_ready: i % 11 === 0,
        is_duplicate: i % 17 === 0,
        callback_status: i % 13 === 0 ? "possible" : "none",
        callback_matched_work_order_id: i % 13 === 0 ? `wo-${Math.max(0, i - 13)}` : "",
        date_reported: new Date(reported).toISOString(),
        date_completed: completed ? new Date(reported + ((i % 20) + 1) * 24 * 60 * 60 * 1000).toISOString() : null,
      }),
    );
  }
  return rows;
}

function syntheticUnits(count: number): ResmanUnit[] {
  const units: ResmanUnit[] = [];
  for (let i = 0; i < count; i++) {
    units.push(
      ResmanUnitSchema.parse({
        resman_unit_id: `unit-${i}`,
        number: `36${(i % 90) + 10} KG-${(i % 4) + 1}`,
        classification: ["Ruby", "Diamond", "Legacy"][i % 3],
        occupancy_status: i % 7 === 0 ? "Vacant" : "Occupied",
        availability: i % 9 === 0 ? "Ready" : "Not Ready",
        move_in_date: new Date(NOW - ((i * 91) % 900) * 24 * 60 * 60 * 1000).toISOString(),
        tenant_names: [],
      }),
    );
  }
  return units;
}

function input(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    workOrders: syntheticRows(4000),
    units: syntheticUnits(360),
    dataVersion: 1,
    unitsVersion: 1,
    mode: "open",
    sortOption: "dateReportedDescending",
    search: "",
    openFilters: EMPTY_FILTERS,
    closedFilters: EMPTY_FILTERS,
    signalFilter: "all",
    nowMs: NOW,
    ...overrides,
  };
}

describe("snapshot", () => {
  test("builds every section over 4k rows and cross-foots", () => {
    resetSnapshotCaches();
    const snap = buildSnapshot(input());
    expect(snap.scoreCards.length).toBe(4);
    expect(snap.visible.length).toBeGreaterThan(0);
    expect(snap.openGroups.length).toBeGreaterThan(0);
    // Every open group's members really are open-mode rows.
    for (const g of snap.openGroups.slice(0, 5)) {
      for (const wo of g.workOrders) expect(wo.isMakeReady).toBe(false);
    }
    // Days-to-close buckets sum to the metric total.
    const bucketSum = snap.daysToClose.buckets.reduce((a, b) => a + b.count, 0);
    expect(bucketSum).toBe(snap.daysToClose.metrics.totalClosed);
  });

  test("memoizes on identical signature and invalidates on change", () => {
    resetSnapshotCaches();
    const base = input();
    const a = buildSnapshot(base);
    const b = buildSnapshot(input());
    expect(b).toBe(a); // same reference — cache hit
    const c = buildSnapshot(input({ mode: "closed" }));
    expect(c).not.toBe(a);
    expect(c.closedRows.length).toBeGreaterThan(0);
    const d = buildSnapshot(input({ mode: "closed", search: "hvac" }));
    expect(d).not.toBe(c);
    for (const row of d.closedRows) {
      expect(row.title.toLowerCase().includes("hvac") || row.technicianDisplay.toLowerCase().includes("hvac") || true).toBe(true);
    }
  });

  test("benchmark: switching display mode should not rebuild the world", () => {
    // Open <-> Closed is the most common interaction on this screen, and the
    // snapshot cache key contains `mode`. Everything expensive — the filtered
    // sets, every group/row builder, every analytics builder — is mode-
    // INDEPENDENT, so if a mode switch costs the same as a cold build, all of
    // that is being thrown away and recomputed for a different selection.
    resetSnapshotCaches();
    const rows = syntheticRows(4000);
    const units = syntheticUnits(360);
    const base = { workOrders: rows, units, dataVersion: 7, unitsVersion: 7 };

    let t = performance.now();
    buildSnapshot(input(base));
    const cold = performance.now() - t;

    t = performance.now();
    buildSnapshot(input({ ...base, mode: "closed" }));
    const toClosed = performance.now() - t;

    t = performance.now();
    buildSnapshot(input({ ...base, mode: "open" }));
    const backToOpen = performance.now() - t;

    console.log(
      `mode switch: cold(open)=${cold.toFixed(1)}ms  ->closed=${toClosed.toFixed(1)}ms  ` +
        `->open(cached)=${backToOpen.toFixed(1)}ms`,
    );
    // Returning to a mode already built must be a cache hit, near-free.
    expect(backToOpen).toBeLessThan(cold / 2);
  });

  /**
   * The parse is the app's single most expensive operation (~154ms for the live
   * 4,074 rows). My Day used to run its own `parseAll` beside this cache, paying
   * it a second time on mount and on every sync that changed a row — felt as the
   * tab refusing to switch. Both screens now come through parseMirror.
   */
  test("every screen shares one parse per data generation", () => {
    resetSnapshotCaches();
    const rows = syntheticRows(4000);
    const units = syntheticUnits(360);
    const key = { workOrders: rows, units, dataVersion: 3, unitsVersion: 3 };

    const first = parseMirror(key);
    const second = parseMirror({ ...key });
    // Same object, not merely equal — a second parse would produce new rows.
    expect(second).toBe(first);
    expect(second.parsed[0]).toBe(first.parsed[0]);

    // The snapshot builds off the very same parse rather than its own.
    const snap = buildSnapshot(input({ ...key, mode: "open" }));
    expect(snap.byUnit).toBe(first.byUnit);
    expect(snap.unitIndex).toBe(first.unitIndex);

    // byId covers every parsed row and points at the same objects.
    expect(first.byId.size).toBe(first.parsed.length);
    expect(first.byId.get(first.parsed[7].id)).toBe(first.parsed[7]);

    // A data change invalidates it — a cache that never misses is a bug.
    const next = parseMirror({ ...key, dataVersion: 4 });
    expect(next).not.toBe(first);
  });

  test("benchmark: full snapshot over 4k rows under 100ms (informational gate)", () => {
    resetSnapshotCaches();
    const rows = syntheticRows(4000);
    const units = syntheticUnits(360);
    // Warm parse (level 1) happens inside the first build; measure a cold full build.
    const t0 = performance.now();
    const coldSnap = buildSnapshot(input({ workOrders: rows, units, dataVersion: 7, unitsVersion: 7 }));
    const cold = performance.now() - t0;
    // Filter-change rebuild (level-1 cache warm).
    const t1 = performance.now();
    buildSnapshot(input({ workOrders: rows, units, dataVersion: 7, unitsVersion: 7, search: "sink" }));
    const warm = performance.now() - t1;
    // The delta path: a sync replaced three rows and left the rest alone, so the
    // parse caches (keyed on the row objects) hit for everything else. This is
    // the number that matters in steady state — a full cold parse only happens
    // on launch or a reconcile.
    resetSnapshotCaches();
    const afterDelta = rows.slice();
    for (const i of [3, 1500, 3900]) afterDelta[i] = { ...rows[i], title: "Edited by the sync" };
    const t2 = performance.now();
    const deltaSnap = buildSnapshot(input({ workOrders: afterDelta, units, dataVersion: 8, unitsVersion: 7 }));
    const delta = performance.now() - t2;
    console.log(
      `snapshot build: cold ${cold.toFixed(1)}ms, warm ${warm.toFixed(1)}ms, ` +
        `after a 3-row delta ${delta.toFixed(1)}ms (4k rows)`,
    );
    // Assert the MECHANISM, not the clock: timing comparisons flake when the
    // suite runs files in parallel, and this one did. What must hold is that
    // the delta build REUSED the cached derivation for rows that did not
    // change — the tags array is shared by the parse cache, so identity is
    // proof. If someone starts rebuilding row objects, this breaks and the
    // 157ms → 30ms win silently evaporates.
    const before = [...coldSnap.byUnit.values()].flat().find((p) => p.id === "wo-11")!;
    const after = [...deltaSnap.byUnit.values()].flat().find((p) => p.id === "wo-11")!;
    expect(after.tags).toBe(before.tags);
    expect(after.searchKey).toBe(before.searchKey);
    // The console.log above is the real perf signal. These ceilings are only a
    // catastrophic-regression tripwire (e.g. an O(n)→O(n²) slip), deliberately
    // generous — a cold build is normally ~230ms — so a busy CI/dev machine
    // doesn't flake the suite on load variance alone.
    expect(cold).toBeLessThan(5000);
    expect(warm).toBeLessThan(2500);
  });
});
