import { useMemo } from "react";
import { parseMirror, type ParsedMirror } from "@/lib/derived/snapshot";
import { useUnits } from "@/lib/stores/units";
import { useWorkOrders } from "@/lib/stores/work-orders";

/**
 * The parsed mirror, shared by every screen that needs raw rows.
 *
 * Parsing the mirror costs ~154ms on a desktop for 4,000 work orders and rather
 * more on a phone, so it must happen ONCE per data generation. The derived
 * snapshot already cached it; My Day ran its own `parseAll` beside it, paying
 * the whole cost again on mount and on every sync that changed anything — a
 * stall you feel as the tab refusing to switch.
 */

// The units store swaps its array only when the contents changed, so array
// identity IS the version — this map turns identity into a number the parse
// cache key can use.
//
// ONE map for the whole app on purpose: two modules each keeping their own
// counter would hand out different numbers for the same array, and the two keys
// would evict each other from the single-slot parse cache on every render —
// turning a cache into a guarantee of re-parsing.
const unitsVersions = new WeakMap<object, number>();
let nextUnitsVersion = 1;

export function unitsVersionOf(units: object): number {
  let version = unitsVersions.get(units);
  if (version === undefined) {
    version = nextUnitsVersion++;
    unitsVersions.set(units, version);
  }
  return version;
}

export function useParsedMirror(): ParsedMirror {
  const workOrders = useWorkOrders((s) => s.workOrders);
  const dataVersion = useWorkOrders((s) => s.dataVersion);
  const units = useUnits((s) => s.allUnits);
  return useMemo(
    () => parseMirror({ workOrders, units, dataVersion, unitsVersion: unitsVersionOf(units) }),
    [workOrders, units, dataVersion],
  );
}
