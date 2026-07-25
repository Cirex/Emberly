import { useEffect, useMemo, useSyncExternalStore } from "react";
import { InteractionManager } from "react-native";
import {
  hasCompleteMirror,
  mirrorKeyOf,
  parseMirror,
  type ParsedMirror,
} from "@/lib/derived/snapshot";
import { useUnits } from "@/lib/stores/units";
import { useWorkOrders } from "@/lib/stores/work-orders";

/**
 * The parsed mirror, in two stages: open work first, everything after.
 *
 * Measured on device, parsing all 4,074 rows costs 706ms — 72% of My Day's
 * 982ms first mount. It buys the launch screen almost nothing: My Day shows
 * only OPEN work, 387 rows, under a tenth of the corpus. So the first pass
 * parses just those and the screen paints; the rest follows once the frame is
 * out the door.
 *
 * The second pass is cheap for the rows the first already did — parsing caches
 * tags and fingerprints against the row object (see @emberly/core), so the wide
 * pass only really pays for the closed rows it adds.
 *
 * Staging is invisible on every later render: once a generation is fully
 * parsed, `parseMirror` returns it and no one sees a partial set again.
 */

// The units store swaps its array only when the contents changed, so array
// identity IS the version — this map turns identity into a number the parse
// cache key can use.
//
// ONE map for the whole app on purpose: two modules each keeping their own
// counter would hand out different numbers for the same array, and the two keys
// would evict each other from the parse cache on every render — turning a cache
// into a guarantee of re-parsing.
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

/**
 * A completed wide parse must reach EVERY mounted screen, not just whichever
 * one scheduled it — otherwise the Work Orders board would sit on the open-only
 * set until something unrelated re-rendered it. An external store is the React
 * 19-sanctioned way to make a module-level event a render trigger.
 */
let completions = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function announceCompletion(): void {
  completions += 1;
  for (const listener of listeners) listener();
}

export function useParsedMirror(): ParsedMirror {
  const workOrders = useWorkOrders((s) => s.workOrders);
  const dataVersion = useWorkOrders((s) => s.dataVersion);
  const units = useUnits((s) => s.allUnits);
  const unitsVersion = unitsVersionOf(units);
  const key = mirrorKeyOf({ workOrders, units, dataVersion, unitsVersion });

  // Re-reads the caches when a wide parse finishes anywhere in the app.
  const completion = useSyncExternalStore(
    subscribe,
    () => completions,
    () => completions,
  );

  const mirror = useMemo(
    () => {
      const input = { workOrders, units, dataVersion, unitsVersion };
      // The narrow parse is a LAUNCH affordance, not a mode: as soon as the
      // wide one exists for this generation, that is what everybody gets.
      return parseMirror(input, hasCompleteMirror(key) ? "all" : "open");
      // `key` covers workOrders/units/dataVersion/unitsVersion — it IS their
      // identity — and `completion` re-checks the caches after a wide parse.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [key, completion],
  );

  useEffect(() => {
    if (mirror.complete) return;
    let cancelled = false;
    // AFTER the frame that painted the open rows. Running it in the effect body
    // would put it back on the same commit and undo the whole point.
    const task = InteractionManager.runAfterInteractions(() => {
      if (cancelled) return;
      parseMirror({ workOrders, units, dataVersion, unitsVersion }, "all");
      announceCompletion();
    });
    return () => {
      cancelled = true;
      task.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, mirror.complete]);

  return mirror;
}
