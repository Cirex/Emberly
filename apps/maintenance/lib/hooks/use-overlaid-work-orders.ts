import type { WorkOrder } from "@/lib/api/work-orders";
import { applyPendingOverlay, overlaySignature } from "@/lib/derived/pending-overlay";
import { usePendingCloses } from "@/lib/stores/pending-closes";
import { usePendingEdits } from "@/lib/stores/pending-edits";
import { useWorkOrders } from "@/lib/stores/work-orders";

/**
 * The work-order mirror with the device's pending writes applied — what every
 * screen reads (see lib/derived/pending-overlay).
 *
 * `dataVersion` here is NOT the store's counter: it must also move when only
 * the overlay moves, or the parse cache would keep serving the pre-edit rows.
 * It is minted from the overlaid array's identity instead.
 *
 * The overlay is memoized at MODULE level, one entry, for the same reason
 * unitsVersionOf is: every caller must receive the identical array, or two
 * callers mint two versions for the same data and evict each other from the
 * parse cache on every render.
 */

let last: {
  base: readonly WorkOrder[];
  signature: string;
  rows: readonly WorkOrder[];
} | null = null;

const versions = new WeakMap<object, number>();
let nextVersion = 1;

function versionOf(rows: readonly WorkOrder[]): number {
  let v = versions.get(rows);
  if (v === undefined) {
    v = nextVersion++;
    versions.set(rows, v);
  }
  return v;
}

export function overlaidWorkOrders(
  base: readonly WorkOrder[],
  edits: Parameters<typeof applyPendingOverlay>[1],
  closes: Parameters<typeof applyPendingOverlay>[2],
): { workOrders: WorkOrder[]; dataVersion: number } {
  const signature = overlaySignature(edits, closes);
  if (!last || last.base !== base || last.signature !== signature) {
    last = { base, signature, rows: applyPendingOverlay(base, edits, closes) };
  }
  // The snapshot engine takes a mutable array type but never mutates it.
  return { workOrders: last.rows as WorkOrder[], dataVersion: versionOf(last.rows) };
}

export function useOverlaidWorkOrders(): { workOrders: WorkOrder[]; dataVersion: number } {
  const base = useWorkOrders((s) => s.workOrders);
  const edits = usePendingEdits((s) => s.pending);
  const closes = usePendingCloses((s) => s.pending);
  return overlaidWorkOrders(base, edits, closes);
}
