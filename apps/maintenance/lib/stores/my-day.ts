import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { buildPath, dayKeyOf, isEmergency, rankUnits, techMatches } from "@/lib/derived/my-path";
import type { ParsedWorkOrder } from "@/lib/derived/types";
import { PLACED_UNITS } from "@/lib/map-data";
import { useTour } from "@/lib/stores/tour";

/** Unit-number → page-space centroid, for proximity-aware path routing. */
const UNIT_CENTERS: ReadonlyMap<string, { x: number; y: number }> = new Map(
  PLACED_UNITS.map((u) => [u.number, { x: u.cx, y: u.cy }]),
);

/**
 * The technician's daily path — powered by the tour engine's models but its
 * OWN list, independent of the map's manual Tour Mode. Reconciled against the
 * live mirror on every data tick:
 *
 *   - Emergencies pin to the top the moment they appear (assigned or not).
 *   - The path refills itself: when live stops drop below TARGET, the next
 *     best unit from the technician's remaining queue is appended.
 *   - Stops whose work orders are all closed (mirror or pending-close) cross
 *     off automatically.
 *   - Completed stops stay listed until the next day; at rollover the done
 *     route is snapshotted into tour history and the path rebuilds fresh.
 */

export interface MyDayStop {
  id: string;
  unitNumber: string;
  workOrderIds: string[];
  addedBy: "auto" | "manual" | "emergency";
  isDone: boolean;
}

const TARGET = 12;

let seq = 0;
function stopId(): string {
  seq = (seq + 1) % 36 ** 3;
  return `day-${Date.now().toString(36)}-${seq.toString(36)}-${Math.floor(Math.random() * 36 ** 4).toString(36)}`;
}

export interface ReconcileInput {
  /** Parsed OPEN work orders, the whole property. */
  openWorkOrders: ParsedWorkOrder[];
  /** Signed-in staff display name (matched against technicianDisplay). */
  staffName: string;
  /** Work orders the tech optimistically closed (pending ResMan). */
  pendingClosedIds: ReadonlySet<string>;
  nowMs: number;
}

interface MyDayState {
  dayKey: string;
  stops: MyDayStop[];
  builtAtMs: number;
  reconcile: (input: ReconcileInput) => void;
  /** Full rebuild of the not-done portion (the Rebuild button). */
  rebuild: (input: ReconcileInput) => void;
  addUnit: (unitNumber: string, workOrderIds: string[]) => void;
  removeStop: (id: string) => void;
  setDone: (id: string, done: boolean) => void;
}

/** Stops that still count against the live-path target. */
function liveCount(stops: MyDayStop[]): number {
  return stops.filter((s) => !s.isDone).length;
}

function reconcileStops(stops: MyDayStop[], input: ReconcileInput): MyDayStop[] {
  const { openWorkOrders, staffName, pendingClosedIds, nowMs } = input;
  const openById = new Map(openWorkOrders.map((wo) => [wo.id, wo]));
  const next: MyDayStop[] = [];
  const seenUnits = new Set<string>();

  // 1. Existing stops: auto-done when every work order is gone from the open
  //    mirror or optimistically closed. Never resurrect a manual done.
  for (const stop of stops) {
    const stillOpen = stop.workOrderIds.filter(
      (id) => openById.has(id) && !pendingClosedIds.has(id),
    );
    const autoDone = stillOpen.length === 0;
    next.push({ ...stop, isDone: stop.isDone || autoDone });
    seenUnits.add(stop.unitNumber);
  }

  // 2. Emergencies pin to the top — any open emergency at the property,
  //    assigned or not, that isn't already a stop.
  const emergencies = rankUnits(
    openWorkOrders.filter((wo) => isEmergency(wo) && !pendingClosedIds.has(wo.id)),
  ).filter((c) => !seenUnits.has(c.unitNumber));
  const emergencyStops: MyDayStop[] = emergencies.map((c) => {
    seenUnits.add(c.unitNumber);
    return {
      id: stopId(),
      unitNumber: c.unitNumber,
      workOrderIds: c.workOrders.map((wo) => wo.id),
      addedBy: "emergency",
      isDone: false,
    };
  });
  let merged = [...emergencyStops, ...next];

  // 3. Refill: append the technician's next best units until TARGET live stops.
  const deficit = TARGET - liveCount(merged);
  if (deficit > 0) {
    const pool = openWorkOrders.filter(
      (wo) =>
        techMatches(staffName, wo) &&
        !pendingClosedIds.has(wo.id) &&
        !seenUnits.has(wo.unitNumber.trim()),
    );
    // Weighted value score + proximity-aware walk (the refill in the order the
    // tech should drive it), not the old strict-tier sort.
    for (const c of buildPath(pool, { centers: UNIT_CENTERS, nowMs, size: deficit })) {
      merged.push({
        id: stopId(),
        unitNumber: c.unitNumber,
        workOrderIds: c.workOrders.map((wo) => wo.id),
        addedBy: "auto",
        isDone: false,
      });
    }
  }
  return merged;
}

export const useMyDay = create<MyDayState>()(
  persist(
    (set, get) => ({
      dayKey: "",
      stops: [],
      builtAtMs: 0,

      reconcile: (input) => {
        const state = get();
        const today = dayKeyOf(input.nowMs);

        let stops = state.stops;
        let builtAtMs = state.builtAtMs;

        // Day rollover: archive yesterday's completed stops into tour history
        // (the recap the tech reviewed all day), then start fresh.
        if (state.dayKey !== today) {
          const done = stops.filter((s) => s.isDone);
          if (done.length > 0) {
            useTour.getState().archiveCompleted(
              done.map((s) => ({
                id: s.id,
                unitNumber: s.unitNumber,
                note: "",
                isDone: true,
              })),
            );
          }
          stops = [];
          builtAtMs = input.nowMs;
        }

        const nextStops = reconcileStops(stops, input);
        if (builtAtMs === 0 && nextStops.length > 0) builtAtMs = input.nowMs;

        // Only write when something actually changed — this runs every tick.
        const same =
          state.dayKey === today &&
          nextStops.length === state.stops.length &&
          nextStops.every((s, i) => {
            const prev = state.stops[i];
            return (
              prev !== undefined &&
              prev.id === s.id &&
              prev.isDone === s.isDone &&
              // Compare the work-order ids element-wise, not just the count: a
              // reassignment that swaps one ticket for another keeps the length
              // equal, and a length-only check would leave the row rendering the
              // stale ids/titles.
              prev.workOrderIds.length === s.workOrderIds.length &&
              prev.workOrderIds.every((id, j) => id === s.workOrderIds[j])
            );
          });
        if (same) return;
        set({ dayKey: today, stops: nextStops, builtAtMs });
      },

      rebuild: (input) => {
        // Keep completed stops (the recap) and manual picks; rebuild the rest.
        const kept = get().stops.filter((s) => s.isDone || s.addedBy === "manual");
        set({ stops: kept, builtAtMs: input.nowMs, dayKey: dayKeyOf(input.nowMs) });
        get().reconcile(input);
      },

      addUnit: (unitNumber, workOrderIds) => {
        const unit = unitNumber.trim();
        if (unit.length === 0 || workOrderIds.length === 0) return;
        set((s) => {
          if (s.stops.some((stop) => stop.unitNumber === unit && !stop.isDone)) return s;
          return {
            stops: [
              ...s.stops,
              { id: stopId(), unitNumber: unit, workOrderIds, addedBy: "manual", isDone: false },
            ],
          };
        });
      },

      removeStop: (id) => set((s) => ({ stops: s.stops.filter((stop) => stop.id !== id) })),

      setDone: (id, done) =>
        set((s) => ({
          stops: s.stops.map((stop) => (stop.id === id ? { ...stop, isDone: done } : stop)),
        })),
    }),
    {
      name: "emberly-maintenance-my-day",
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
