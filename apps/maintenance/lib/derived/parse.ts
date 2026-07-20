import type { WorkOrder } from "@/lib/api/work-orders";
import { daysBetween, parseDate, type ParsedWorkOrder } from "./types";
import { computeWorkOrderSignals, type EngineOrder } from "./wo-engine";
import { deriveWorkOrderTags } from "./wo-tags";

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

/** Parse one API row into the engine's view model. Pure; called once per row per dataVersion. */
export function parseWorkOrder(raw: WorkOrder): ParsedWorkOrder {
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
    isMakeReady: raw.is_make_ready,
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

export function parseAll(rows: WorkOrder[]): ParsedWorkOrder[] {
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
