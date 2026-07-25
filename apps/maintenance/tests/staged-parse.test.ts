import { describe, expect, test, beforeEach } from "bun:test";
import { WorkOrderSchema, type WorkOrder } from "../lib/api/work-orders";
import { ResmanUnitSchema, type ResmanUnit } from "../lib/api/units";
import {
  buildSnapshot,
  hasCompleteMirror,
  mirrorKeyOf,
  parseMirror,
  resetSnapshotCaches,
  type SnapshotInput,
} from "../lib/derived/snapshot";
import { EMPTY_FILTERS } from "../lib/derived/types";

/**
 * The staged parse: open work first so the launch screen paints, everything
 * after.
 *
 * Measured on device, parsing all 4,074 rows is 706ms and 72% of My Day's first
 * mount — while My Day only ever shows open work, under a tenth of the corpus.
 *
 * Two ways this goes silently wrong, and both are worse than being slow:
 *   - the narrow parse gets CACHED as if it were the whole board, so closed
 *     work never appears and nothing ever recomputes;
 *   - a screen reports a confident zero ("no closed work orders") from a set
 *     that was never meant to contain any.
 */

const NOW = Date.parse("2026-07-25T12:00:00");

function wo(fields: Partial<WorkOrder> & { resman_work_order_id: string }): WorkOrder {
  return WorkOrderSchema.parse({
    unit_number: "0101",
    date_reported: "2026-07-01T09:00:00",
    ...fields,
  });
}

function unit(number: string): ResmanUnit {
  return ResmanUnitSchema.parse({ resman_unit_id: `u-${number}`, number, tenant_names: [] });
}

const ROWS: WorkOrder[] = [
  wo({ resman_work_order_id: "open-1", status: "Open", title: "AC not cooling" }),
  wo({ resman_work_order_id: "open-2", status: "In Progress", title: "Sink leaking" }),
  wo({ resman_work_order_id: "done-1", status: "Completed", title: "Toilet running", date_completed: "2026-07-10T09:00:00" }),
  wo({ resman_work_order_id: "done-2", status: "Closed", title: "Light out", date_completed: "2026-07-11T09:00:00" }),
  wo({ resman_work_order_id: "done-3", status: "Cancelled", title: "Duplicate request" }),
  // A status the app has never seen. It must survive the narrow parse: a row
  // nobody can classify is exactly the one somebody needs to see.
  wo({ resman_work_order_id: "odd-1", status: "Awaiting Parts", title: "Door handle" }),
];

const UNITS = [unit("0101")];
const INPUT = { workOrders: ROWS, units: UNITS, dataVersion: 1, unitsVersion: 1 };

function snapshotInput(over: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    workOrders: ROWS,
    units: UNITS,
    dataVersion: 1,
    unitsVersion: 1,
    mode: "closed",
    sortOption: "dateCompletedDescending",
    search: "",
    openFilters: EMPTY_FILTERS,
    closedFilters: EMPTY_FILTERS,
    signalFilter: "all",
    nowMs: NOW,
    ...over,
  };
}

describe("staged parse", () => {
  beforeEach(() => resetSnapshotCaches());

  test("the narrow pass carries open work and skips the closed rows", () => {
    const open = parseMirror(INPUT, "open");
    const ids = open.parsed.map((p) => p.id).sort();
    expect(ids).toEqual(["odd-1", "open-1", "open-2"]);
    expect(open.complete).toBe(false);
  });

  test("the wide pass carries everything and says so", () => {
    const all = parseMirror(INPUT, "all");
    expect(all.parsed).toHaveLength(ROWS.length);
    expect(all.complete).toBe(true);
    expect(hasCompleteMirror(mirrorKeyOf(INPUT))).toBe(true);
  });

  test("open rows parse identically either way", () => {
    // The narrow pass is a subset, never a different answer. If it derived
    // different tags or dates, the board would visibly change under the
    // technician a beat after launch.
    const narrow = parseMirror(INPUT, "open");
    const openFromNarrow = narrow.parsed.find((p) => p.id === "open-1")!;
    resetSnapshotCaches();
    const wide = parseMirror(INPUT, "all");
    const openFromWide = wide.parsed.find((p) => p.id === "open-1")!;

    expect(openFromNarrow.tags).toEqual(openFromWide.tags);
    expect(openFromNarrow.searchKey).toBe(openFromWide.searchKey);
    expect(openFromNarrow.reportedAt).toBe(openFromWide.reportedAt);
    expect(openFromNarrow.isMakeReady).toBe(openFromWide.isMakeReady);
  });

  test("once the wide parse exists, nobody is handed the narrow one again", () => {
    parseMirror(INPUT, "all");
    // Staging is a launch affordance, not a mode — asking for "open" after the
    // full parse has landed must not walk the board backwards.
    const asked = parseMirror(INPUT, "open");
    expect(asked.complete).toBe(true);
    expect(asked.parsed).toHaveLength(ROWS.length);
  });

  test("a new data generation invalidates both scopes", () => {
    parseMirror(INPUT, "all");
    const next = { ...INPUT, dataVersion: 2 };
    expect(hasCompleteMirror(mirrorKeyOf(next))).toBe(false);
    expect(parseMirror(next, "open").complete).toBe(false);
  });

  test("a partial snapshot is never cached over the full one", () => {
    // THE failure that would look like data loss: build the snapshot from the
    // narrow mirror, and if the scope is missing from the cache key the closed
    // board keeps serving zero rows for the rest of the session.
    const narrow = parseMirror(INPUT, "open");
    const partial = buildSnapshot(snapshotInput(), narrow);
    expect(partial.complete).toBe(false);
    expect(partial.closedRows).toHaveLength(0);

    const wide = parseMirror(INPUT, "all");
    const full = buildSnapshot(snapshotInput(), wide);
    expect(full.complete).toBe(true);
    expect(full.closedRows.length).toBeGreaterThan(0);
    expect(full).not.toBe(partial);
  });

  test("a snapshot built without a mirror is complete by definition", () => {
    // Every existing caller passes no mirror and must keep getting the whole
    // board, with `complete` true rather than undefined.
    const snap = buildSnapshot(snapshotInput());
    expect(snap.complete).toBe(true);
    expect(snap.closedRows.length).toBeGreaterThan(0);
  });
});
