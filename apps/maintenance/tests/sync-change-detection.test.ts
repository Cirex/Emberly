import { describe, expect, test } from "bun:test";
import { mirrorDiffers, rowEqual, rowsEqual } from "@/lib/stores/row-compare";
import type { WorkOrder } from "@/lib/api/work-orders";

/**
 * "Did anything change?" answered without serializing the payload twice.
 *
 * The stores used `JSON.stringify(a) !== JSON.stringify(b)`, which built two
 * full string copies of the mirror (3.79 MB) or the roster (2.2 MB) on every
 * background tick, almost always to conclude that nothing moved.
 *
 * Both directions matter. Reporting a change that did not happen re-renders
 * every screen and rewrites the cache; MISSING one leaves a technician looking
 * at stale work.
 */

function wo(over: Partial<WorkOrder> = {}): WorkOrder {
  return {
    resman_work_order_id: "wo-1",
    number: "1",
    unit_number: "0101",
    status: "Open",
    updated_at: "2026-07-25T10:00:00Z",
    ...over,
  } as WorkOrder;
}

describe("mirror change detection", () => {
  test("an unchanged fetch reports no change", () => {
    const prev = [wo({ resman_work_order_id: "a" }), wo({ resman_work_order_id: "b" })];
    const next = [wo({ resman_work_order_id: "a" }), wo({ resman_work_order_id: "b" })];
    expect(mirrorDiffers(next, prev)).toBe(false);
  });

  test("a row whose updated_at moved reports a change", () => {
    const prev = [wo({ resman_work_order_id: "a" })];
    const next = [wo({ resman_work_order_id: "a", updated_at: "2026-07-25T11:00:00Z" })];
    expect(mirrorDiffers(next, prev)).toBe(true);
  });

  test("added and deleted rows both report a change", () => {
    const prev = [wo({ resman_work_order_id: "a" })];
    expect(mirrorDiffers([...prev, wo({ resman_work_order_id: "b" })], prev)).toBe(true);
    expect(mirrorDiffers([], prev)).toBe(true);
  });

  test("a swap of equal size is caught by identity, not just by count", () => {
    // Same length, different rows — a count check alone would miss this.
    const prev = [wo({ resman_work_order_id: "a" })];
    const next = [wo({ resman_work_order_id: "z" })];
    expect(mirrorDiffers(next, prev)).toBe(true);
  });

  test("order alone is NOT a change", () => {
    // The string compare this replaced said "changed" here, which is why a
    // reconcile after a delta merge — where rows sit in merge order rather than
    // server order — rebuilt every derived view to confirm nothing happened.
    const a = wo({ resman_work_order_id: "a" });
    const b = wo({ resman_work_order_id: "b" });
    expect(mirrorDiffers([b, a], [a, b])).toBe(false);
  });
});

describe("row comparison", () => {
  test("equal rows, changed field, changed length", () => {
    expect(rowEqual({ a: 1, b: "x" }, { a: 1, b: "x" })).toBe(true);
    expect(rowEqual({ a: 1, b: "x" }, { a: 1, b: "y" })).toBe(false);
    expect(rowsEqual([{ a: 1 }], [{ a: 1 }])).toBe(true);
    expect(rowsEqual([{ a: 1 }], [{ a: 1 }, { a: 2 }])).toBe(false);
  });

  test("string arrays compare by contents — tenant_names is one", () => {
    expect(rowEqual({ names: ["Ann", "Bo"] }, { names: ["Ann", "Bo"] })).toBe(true);
    expect(rowEqual({ names: ["Ann"] }, { names: ["Ann", "Bo"] })).toBe(false);
    expect(rowEqual({ names: ["Ann", "Bo"] }, { names: ["Bo", "Ann"] })).toBe(false);
  });

  test("a key appearing or vanishing is a change", () => {
    expect(rowEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(rowEqual({ a: 1, b: null }, { a: 1 })).toBe(false);
  });

  test("null and nested objects do not crash the compare", () => {
    expect(rowEqual(null, null)).toBe(true);
    expect(rowEqual(null, { a: 1 })).toBe(false);
    // Nested objects are compared by identity — the mirrors are flat, so this
    // only ever errs toward reporting a change.
    const shared = { deep: 1 };
    expect(rowEqual({ o: shared }, { o: shared })).toBe(true);
    expect(rowEqual({ o: { deep: 1 } }, { o: { deep: 1 } })).toBe(false);
  });
});
