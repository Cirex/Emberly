/**
 * Work-order parsing — the shared view model every Emberly app derives its
 * maintenance surfaces from (promoted from apps/maintenance/lib/derived/
 * {types,parse}.ts so the manager app can reuse it verbatim instead of
 * re-deriving "what's broken" a second time).
 *
 * Dependency-free by contract: the raw row shapes below are declared
 * structurally, so each app keeps owning its own zod schema for
 * GET /api/resman/work-orders and GET /api/resman/units and simply hands the
 * parsed rows in. Anything that needs i18next (score-card copy, board labels)
 * stays in the app.
 */

import { calendarDaysBetween, daysBetween } from "./calendar";
import { computeWorkOrderSignals, type EngineOrder } from "./work-order-signals";
import { deriveWorkOrderTags } from "./work-order-tags";

// ── Raw mirror rows ─────────────────────────────────────────────────────────

/**
 * A row of the `resman_work_orders` mirror, as every app's zod schema parses
 * it (string columns defaulted to "", date columns nullable). Structural, so
 * an app's `z.infer<typeof WorkOrderSchema>` satisfies it without importing
 * zod here.
 */
export interface WorkOrderInput {
  resman_work_order_id: string;
  number: string;
  unit_number: string;
  status: string;
  priority: string;
  category: string;
  title: string;
  notes: string;
  completion_notes: string;
  technician: string;
  date_reported?: string | null;
  date_scheduled?: string | null;
  date_completed?: string | null;
  is_make_ready: boolean;
  tags: string[];
  is_duplicate: boolean;
  callback_status: string;
  callback_matched_work_order_id: string;
  // Columns the derivations don't read, declared so a full mirror row (or an
  // object literal built from one) satisfies this type without a cast.
  resman_unit_id?: string | null;
  unit_lease_group_id?: string;
  resman_lease_id?: string;
  resman_property_id?: string | null;
  callback_requested?: boolean;
  callback_completed?: boolean;
  callback_engine_version?: string;
  callback_source?: string;
  callback_detected_at?: string | null;
  synced_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** The slice of a `resman_units` mirror row the work-order views join against. */
export interface UnitInput {
  number: string;
  classification?: string | null;
  occupancy_status?: string | null;
  lease_status?: string | null;
  availability?: string | null;
  resman_building_id?: string | null;
  move_in_date?: string | null;
  lease_start_date?: string | null;
  move_out_date?: string | null;
  tenant_names?: string[];
  // Remaining mirror columns, unread here but declared so a full unit row
  // literal satisfies this type without a cast.
  resman_unit_id?: string;
  resman_property_id?: string | null;
  notes?: string | null;
  occupied?: boolean | null;
  market_rent?: number | null;
  lease_rent?: number | null;
  balance?: number | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  holding_unit?: boolean | null;
  excluded_from_occupancy?: boolean | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  lease_end_date?: string | null;
  source_url?: string | null;
  scraped_at?: string | null;
  synced_at?: string | null;
}

// ── Parsed view model ───────────────────────────────────────────────────────

/**
 * Parsed work-order view model — the raw API row with everything the derived
 * engine needs precomputed once per dataVersion: epoch dates (ms, or null),
 * a lowercase search key, and the display technician. All downstream modules
 * consume THIS shape; nothing re-parses dates in a loop.
 */
export interface ParsedWorkOrder {
  raw: WorkOrderInput;
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

// ── Dates ───────────────────────────────────────────────────────────────────

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

export function makeUnitIndex(units: UnitInput[]): UnitIndex {
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

// ── Categories, technicians ─────────────────────────────────────────────────

/**
 * ResMan's report-level MakeReady flag misses rows whose CATEGORY is plainly a
 * make-ready ("Make Ready Maintenance", "Make Ready Not Complete", "Turn
 * Maintenance/Punch", "Inspection and make ready" — 13/1,000 in prod). Fold
 * those in by category so the Open/Closed boards never show turn work; the
 * category taxonomy is deliberate, titles are not, so titles are NOT matched.
 */
const MAKE_READY_CATEGORY = /make.?ready|\bturn\b/i;
export function isMakeReadyCategory(category: string | null | undefined): boolean {
  return MAKE_READY_CATEGORY.test(category ?? "");
}

/**
 * Technician display normalization — port of WorkOrderTechnicianNames
 * (WorkOrderSupport.swift:4-30): blank → "Unassigned"; grounds… → "Grounds
 * Keepers"; maintenance… or generalmaintenance… → "General Maintenance".
 */
export function technicianDisplayName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "Unassigned";
  const folded = trimmed.toLowerCase().replace(/[^a-z]/g, "");
  if (folded.startsWith("grounds")) return "Grounds Keepers";
  if (folded.startsWith("generalmaintenance") || folded.startsWith("maintenance")) {
    return "General Maintenance";
  }
  return trimmed;
}

// ── Status membership ───────────────────────────────────────────────────────

/** Statuses the "open" board owns. Everything else is closed or unknown. */
export const WORK_ORDER_OPEN_STATUSES = [
  "Open",
  "In Progress",
  "Not Started",
  "On Hold",
  "Submitted",
  "Scheduled",
];

/** Both "Cancelled" (Swift) and "Canceled" (the synced mirror's spelling). */
export const WORK_ORDER_CLOSED_STATUSES = ["Closed", "Completed", "Cancelled", "Canceled"];

const OPEN_STATUS_SET = new Set(WORK_ORDER_OPEN_STATUSES);
const CLOSED_STATUS_SET = new Set(WORK_ORDER_CLOSED_STATUSES);

/**
 * Open board membership. Make-readies live on their own board, so open/closed
 * both exclude them — the rule the maintenance app established and the manager
 * app inherits.
 */
export function isOpenWorkOrder(wo: ParsedWorkOrder): boolean {
  return OPEN_STATUS_SET.has(wo.status) && !wo.isMakeReady;
}

export function isClosedWorkOrder(wo: ParsedWorkOrder): boolean {
  return CLOSED_STATUS_SET.has(wo.status) && !wo.isMakeReady;
}

/**
 * Callback signal — persisted by the server's callback engine, or filled in by
 * `parseAll` below. "possible" and "confirmed" both count.
 */
export function isCallbackSignal(wo: ParsedWorkOrder): boolean {
  return wo.callbackStatus === "possible" || wo.callbackStatus === "confirmed";
}

/** Priority order for banding the open board: Emergency first, unknown last. */
export const WORK_ORDER_PRIORITY_ORDER = ["Emergency", "High", "Normal", "Low"];

const PRIORITY_RANK: Record<string, number> = {
  Emergency: 0,
  High: 1,
  Normal: 2,
  Low: 3,
};

export function priorityRank(priority: string): number {
  return PRIORITY_RANK[priority] ?? PRIORITY_RANK.Normal;
}

/** Whole days since the order was reported (0 when the date is missing). */
export function workOrderAgeDays(wo: ParsedWorkOrder, nowMs: number): number {
  if (wo.reportedAt === null) return 0;
  return Math.max(0, calendarDaysBetween(wo.reportedAt, nowMs));
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/** Parse one API row into the engine's view model. Pure; called once per row per dataVersion. */
export function parseWorkOrder(raw: WorkOrderInput): ParsedWorkOrder {
  const reportedAt = parseDate(raw.date_reported);
  const completedAt = parseDate(raw.date_completed);
  const technicianDisplay = technicianDisplayName(raw.technician);
  // ResMan leaves tags/callbacks/duplicates empty on every synced row, so we
  // run the ported Swift engine (WorkOrderDuplicateDetector) instead. Tags are
  // per-order; the callback/duplicate signals need the whole set and are filled
  // in parseAll below. Explicit values (fixtures) are honored over the engine.
  const tags = raw.tags.length > 0 ? raw.tags : deriveWorkOrderTags(raw.title, raw.notes, raw.category);
  return {
    raw,
    id: raw.resman_work_order_id,
    number: raw.number,
    unitNumber: raw.unit_number,
    status: raw.status,
    priority: raw.priority,
    title: raw.title,
    technician: raw.technician,
    technicianDisplay,
    tags,
    isMakeReady: raw.is_make_ready || isMakeReadyCategory(raw.category),
    isDuplicate: raw.is_duplicate,
    callbackStatus: raw.callback_status,
    callbackMatchedId: raw.callback_matched_work_order_id,
    reportedAt,
    scheduledAt: parseDate(raw.date_scheduled),
    completedAt,
    daysToComplete:
      reportedAt !== null && completedAt !== null ? Math.max(0, daysBetween(reportedAt, completedAt)) : null,
    searchKey: [raw.number, raw.unit_number, raw.title, raw.notes, technicianDisplay, tags.join(" ")]
      .join(" ")
      .toLowerCase(),
  };
}

export function parseAll(rows: WorkOrderInput[]): ParsedWorkOrder[] {
  const parsed = rows.map(parseWorkOrder);

  // Callback/duplicate signals over the whole set (the ported Swift engine).
  // Make-ready turns are excluded, matching Swift's shouldEvaluate.
  const engineOrders: EngineOrder[] = parsed
    .filter((p) => !p.isMakeReady)
    .map((p) => ({
      id: p.id,
      unitNumber: p.unitNumber,
      status: p.status,
      title: p.raw.title,
      description: p.raw.notes,
      category: p.raw.category,
      tags: p.tags,
      completionNotes: p.raw.completion_notes,
      reportedAt: p.reportedAt,
      completedAt: p.completedAt,
    }));
  const signals = computeWorkOrderSignals(engineOrders);

  for (const p of parsed) {
    // Honor an explicitly-set signal (fixtures / any future real DB value);
    // the engine only fills what ResMan left at its defaults.
    const rawHasSignal =
      p.raw.callback_status !== "none" ||
      p.raw.is_duplicate ||
      (p.raw.callback_matched_work_order_id ?? "") !== "";
    if (rawHasSignal) continue;
    const s = signals.get(p.id);
    if (s) {
      p.isDuplicate = s.isDuplicate;
      p.callbackStatus = s.callbackStatus;
      p.callbackMatchedId = s.callbackMatchedId;
    }
  }
  return parsed;
}
