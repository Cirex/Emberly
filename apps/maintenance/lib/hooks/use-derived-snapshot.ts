import { useMemo } from "react";
import { buildSnapshot, type DerivedSnapshot } from "@/lib/derived/snapshot";
import type { DisplayMode } from "@/lib/derived/types";
import { useSettings } from "@/lib/stores/settings";
import { useUnits } from "@/lib/stores/units";
import { useWorkOrders } from "@/lib/stores/work-orders";
import { useWorkOrdersView } from "@/lib/stores/work-orders-view";

/**
 * The single subscription point for the Work Orders workspace: joins the two
 * data stores with the view state and hands screens the derived snapshot.
 * buildSnapshot memoizes internally on the full signature (including the
 * calendar day), so re-renders that change nothing reuse the same object.
 */

// The units store swaps its array only when contents changed, so array
// identity IS the version — this map just turns identity into a number the
// snapshot cache key can use.
const unitsVersions = new WeakMap<object, number>();
let nextUnitsVersion = 1;
function versionOf(units: object): number {
  let v = unitsVersions.get(units);
  if (v === undefined) {
    v = nextUnitsVersion++;
    unitsVersions.set(units, v);
  }
  return v;
}
/**
 * @param modeOverride Pin the snapshot to one display mode regardless of the
 * view store — the Make Ready TAB uses this ("makeReady" stopped being a
 * selector mode when it got its own tab, but the derived engine still models
 * it as one).
 */
export function useDerivedSnapshot(modeOverride?: DisplayMode): DerivedSnapshot {
  const language = useSettings((s) => s.language);
  const workOrders = useWorkOrders((s) => s.workOrders);
  const dataVersion = useWorkOrders((s) => s.dataVersion);
  const units = useUnits((s) => s.allUnits);
  const storeMode = useWorkOrdersView((s) => s.displayMode);
  const mode = modeOverride ?? storeMode;
  const sortOption = useWorkOrdersView((s) => s.sortOption);
  const search = useWorkOrdersView((s) => s.debouncedSearch);
  const openFilters = useWorkOrdersView((s) => s.openFilters);
  const closedFilters = useWorkOrdersView((s) => s.closedFilters);
  const signalFilter = useWorkOrdersView((s) => s.signalFilter);

  return useMemo(
    () =>
      buildSnapshot({
        language,
        workOrders,
        units,
        dataVersion,
        unitsVersion: versionOf(units),
        mode,
        sortOption,
        search,
        openFilters,
        closedFilters,
        signalFilter,
        nowMs: Date.now(),
      }),
    [language, workOrders, units, dataVersion, mode, sortOption, search, openFilters, closedFilters, signalFilter],
  );
}
