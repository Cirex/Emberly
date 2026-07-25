import type { WorkOrder } from "@/lib/api/work-orders";

/**
 * "Did this fetch change anything?" without serializing both sides to find out.
 *
 * The stores answered that question with `JSON.stringify(a) !== JSON.stringify(b)`,
 * which builds two full copies of the payload as strings on every background
 * tick — 5.8ms and ~4.4MB of garbage for the 891-unit roster alone, measured on a
 * desktop, every 15 seconds, almost always to conclude that nothing moved.
 *
 * Comparing the rows directly is the same answer for a fraction of the work: the
 * length first (the common real change), then field by field. Rows are flat JSON
 * from PostgREST, so the only non-primitive is an occasional string array.
 */

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  return false;
}

/** Flat-object equality over the union of both rows' keys. */
export function rowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const rowA = a as Record<string, unknown>;
  const rowB = b as Record<string, unknown>;
  const keys = Object.keys(rowA);
  if (keys.length !== Object.keys(rowB).length) return false;
  for (const key of keys) {
    if (!valuesEqual(rowA[key], rowB[key])) return false;
  }
  return true;
}

/**
 * Positional row-by-row equality. Order-sensitive, exactly like the stringify
 * compare it replaces — the API returns a stable server ordering, and a reorder
 * with identical contents is not a case these endpoints produce.
 */
export function rowsEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!rowEqual(a[i], b[i])) return false;
  }
  return true;
}

/**
 * Whether a full work-order read differs from what is cached.
 *
 * By (id, updated_at) rather than field by field: the mirror is 3.79 MB, and
 * `updated_at` already means "this row changed" — the delta sync depends on that
 * (deltas/2026-07-24-work-order-change-detection.sql), so a stamp comparison is
 * both exact and 30 columns cheaper.
 *
 * Order-insensitive, unlike the string compare it replaces. A delta merge leaves
 * rows in merge order rather than server order, so a reconcile that CONFIRMED
 * the cache used to report a change and rebuild every derived view.
 */
export function mirrorDiffers(next: readonly WorkOrder[], prev: readonly WorkOrder[]): boolean {
  if (next.length !== prev.length) return true;
  const stamps = new Map(prev.map((row) => [row.resman_work_order_id, row.updated_at ?? ""]));
  for (const row of next) {
    if (stamps.get(row.resman_work_order_id) !== (row.updated_at ?? "")) return true;
  }
  return false;
}
