import { describe, expect, test } from "bun:test";
import { WorkOrderSchema, type WorkOrder } from "../lib/api/work-orders";
import { ResmanUnitSchema } from "../lib/api/units";
import { parseAll } from "../lib/derived/parse";
import { makeUnitIndex } from "../lib/derived/types";
import { buildOpenGroups } from "../lib/derived/open-groups";
import { buildClosedRows } from "../lib/derived/closed-rows";

/**
 * Derived objects survive a rebuild when their inputs did not change.
 *
 * A sync bumps dataVersion and every derived object is rebuilt. If each rebuild
 * hands the list brand-new objects, every mounted row and card re-renders even
 * though the sync touched a handful of units — measured at a 202ms commit on
 * device, worse on the pass that widens the staged parse.
 *
 * These assert IDENTITY, which is the only thing a memoized component compares.
 * Equality would pass just as happily while the screen re-rendered end to end,
 * so this is a case where `toBe` and `toEqual` mean completely different things.
 */

const NOW = Date.parse("2026-07-25T12:00:00");

function wo(id: string, over: Partial<WorkOrder> = {}): WorkOrder {
  return WorkOrderSchema.parse({
    resman_work_order_id: id,
    number: id.replace(/\D/g, "") || "1",
    unit_number: "0101",
    status: "Open",
    title: "AC not cooling",
    date_reported: "2026-07-20T09:00:00",
    updated_at: "2026-07-20T09:00:00Z",
    ...over,
  });
}

const UNITS = [
  ResmanUnitSchema.parse({ resman_unit_id: "u1", number: "0101", classification: "Ruby", tenant_names: [] }),
  ResmanUnitSchema.parse({ resman_unit_id: "u2", number: "0202", classification: "Legacy", tenant_names: [] }),
];
const unitIndex = makeUnitIndex(UNITS);

const openArgs = (rows: WorkOrder[]) => ({
  workOrders: parseAll(rows),
  option: "dateReportedDescending" as const,
  unitIndex,
  nowMs: NOW,
});

describe("open groups survive a rebuild", () => {
  test("an untouched unit keeps its group object", () => {
    const rows = [wo("a", { unit_number: "0101" }), wo("b", { unit_number: "0202" })];
    const first = buildOpenGroups(openArgs(rows));
    // What a delta sync produces: the same raw rows, re-parsed into new
    // ParsedWorkOrder instances. The GROUP must not follow them.
    const second = buildOpenGroups(openArgs(rows));

    const unitOf = (gs: typeof first, u: string) => gs.find((g) => g.unitNumber === u)!;
    expect(unitOf(second, "0101")).toBe(unitOf(first, "0101"));
    expect(unitOf(second, "0202")).toBe(unitOf(first, "0202"));
  });

  test("a changed unit gets a new group, and only that one", () => {
    const rows = [wo("a", { unit_number: "0101" }), wo("b", { unit_number: "0202" })];
    const first = buildOpenGroups(openArgs(rows));
    const changed = [rows[0], wo("b", { unit_number: "0202", title: "Toilet running" })];
    const second = buildOpenGroups(openArgs(changed));

    const unitOf = (gs: typeof first, u: string) => gs.find((g) => g.unitNumber === u)!;
    expect(unitOf(second, "0202")).not.toBe(unitOf(first, "0202"));
    expect(unitOf(second, "0101")).toBe(unitOf(first, "0101"));
  });

  test("a different ordering is a different group, not a stale one", () => {
    // The sort option decides row order INSIDE a card, so it cannot be shared
    // across orderings — that would silently show the wrong order.
    const rows = [wo("a", { unit_number: "0101" }), wo("c", { unit_number: "0101", date_reported: "2026-07-10T09:00:00" })];
    const desc = buildOpenGroups(openArgs(rows))[0];
    const asc = buildOpenGroups({ ...openArgs(rows), option: "dateReportedAscending" })[0];
    expect(asc).not.toBe(desc);
    expect(asc.workOrders[0].id).not.toBe(desc.workOrders[0].id);
  });

  test("a new calendar day rebuilds — the rail is drawn relative to today", () => {
    const rows = [wo("a", { unit_number: "0101" })];
    const today = buildOpenGroups(openArgs(rows))[0];
    const tomorrow = buildOpenGroups({ ...openArgs(rows), nowMs: NOW + 24 * 60 * 60 * 1000 })[0];
    expect(tomorrow).not.toBe(today);
  });
});

describe("closed rows survive a rebuild", () => {
  const closedArgs = (rows: WorkOrder[]) => ({
    workOrders: parseAll(rows),
    option: "dateCompletedDescending" as const,
    unitIndex,
    nowMs: NOW,
  });
  const closed = (id: string, over: Partial<WorkOrder> = {}) =>
    wo(id, { status: "Completed", date_completed: "2026-07-22T09:00:00", ...over });

  test("an unchanged row keeps its object across rebuilds", () => {
    const rows = [closed("x"), closed("y")];
    const first = buildClosedRows(closedArgs(rows));
    const second = buildClosedRows(closedArgs(rows));
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  test("a replaced row is rebuilt", () => {
    const rows = [closed("x"), closed("y")];
    const first = buildClosedRows(closedArgs(rows));
    const second = buildClosedRows(closedArgs([rows[0], closed("y", { title: "Something else" })]));
    const byId = (list: typeof first, id: string) => list.find((r) => r.id === id)!;
    expect(byId(second, "x")).toBe(byId(first, "x"));
    expect(byId(second, "y")).not.toBe(byId(first, "y"));
    expect(byId(second, "y").title).toBe("Something else");
  });

  test("a new day rebuilds — the date label is relative", () => {
    const rows = [closed("x")];
    const today = buildClosedRows(closedArgs(rows))[0];
    const nextYear = buildClosedRows({ ...closedArgs(rows), nowMs: NOW + 400 * 24 * 60 * 60 * 1000 })[0];
    expect(nextYear).not.toBe(today);
    // Same row, a year on: the label now has to carry the year.
    expect(nextYear.dateCompletedText).not.toBe(today.dateCompletedText);
  });
});
