import type { WorkOrder } from "@/lib/api/work-orders";
import type { ResmanUnit } from "@/lib/api/units";

/**
 * Parsed work-order view model — the raw API row with everything the derived
 * engine needs precomputed once per dataVersion: epoch dates (ms, or null),
 * a lowercase search key, and the display technician. All downstream modules
 * consume THIS shape; nothing re-parses dates in a loop.
 */
export interface ParsedWorkOrder {
  raw: WorkOrder;
  id: string;
  number: string;
  unitNumber: string;
  status: string;
  priority: string;
  title: string;
  technician: string;
  /** Normalized display name ("Unassigned", "Grounds Keepers", …). */
  technicianDisplay: string;
  tags: string[];
  isMakeReady: boolean;
  isDuplicate: boolean;
  callbackStatus: string;
  callbackMatchedId: string;
  reportedAt: number | null;
  scheduledAt: number | null;
  completedAt: number | null;
  /** Whole days from reported→completed, when both exist. */
  daysToComplete: number | null;
  /** Lowercased haystack for search: number, unit, title, notes, technician, tags. */
  searchKey: string;
}

/** The slice of the unit mirror the work-order views join against. */
export interface UnitFacts {
  unitNumber: string;
  classification: string;
  occupancyStatus: string;
  leaseStatus: string;
  /** ResMan availability text ("Ready", …) — the make-ready board's unit status. */
  availability: string;
  building: string;
  moveInAt: number | null;
  leaseStartAt: number | null;
  moveOutAt: number | null;
  tenantNames: string[];
}

export type UnitIndex = Map<string, UnitFacts>;

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

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDate(value: string | null | undefined): number | null {
  if (!value) return null;
  // Date-only strings ("2026-07-20") are parsed by Date.parse as UTC midnight,
  // which lands on the PREVIOUS local evening in any negative-offset timezone —
  // shifting completions/reports back a day and zeroing "this week/month" math
  // (all of startOfDay/Week/Month is local). Parse them as LOCAL midnight so
  // calendar bucketing matches the calendar date ResMan recorded.
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime();
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole calendar-day difference (UTC-agnostic, floor). */
export function daysBetween(fromMs: number, toMs: number): number {
  return Math.floor((toMs - fromMs) / DAY_MS);
}

export function makeUnitIndex(units: ResmanUnit[]): UnitIndex {
  const index: UnitIndex = new Map();
  for (const u of units) {
    if (!u.number) continue;
    index.set(u.number, {
      unitNumber: u.number,
      classification: u.classification ?? "",
      occupancyStatus: u.occupancy_status ?? "",
      leaseStatus: u.lease_status ?? "",
      availability: u.availability ?? "",
      building: u.resman_building_id ?? "",
      moveInAt: parseDate(u.move_in_date),
      leaseStartAt: parseDate(u.lease_start_date),
      moveOutAt: parseDate(u.move_out_date),
      tenantNames: u.tenant_names ?? [],
    });
  }
  return index;
}
