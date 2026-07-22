/**
 * The derived engine's view model. The work-order/unit shapes and the date
 * math were PROMOTED to @emberly/core (packages/core/src/work-orders.ts) so
 * the manager app parses the identical mirror rows; this module re-exports
 * them under the app's existing import path and keeps the board-state types,
 * which are this app's UI vocabulary.
 */

import type { ResmanUnit } from "@/lib/api/units";
import { makeUnitIndex as coreMakeUnitIndex, type UnitIndex } from "@emberly/core";

export type { ParsedWorkOrder, UnitFacts, UnitIndex } from "@emberly/core";
export { DAY_MS, daysBetween, parseDate } from "@emberly/core";

/** Index the app's parsed unit rows by unit number. */
export function makeUnitIndex(units: ResmanUnit[]): UnitIndex {
  return coreMakeUnitIndex(units);
}

export type DisplayMode = "open" | "closed" | "makeReady" | "hotSpots";
export type SignalFilter = "all" | "callbacks" | "duplicates";

export interface FilterSets {
  status: string[];
  classification: string[];
  occupancy: string[];
  technician: string[];
  tags: string[];
}

export const EMPTY_FILTERS: FilterSets = {
  status: [],
  classification: [],
  occupancy: [],
  technician: [],
  tags: [],
};
