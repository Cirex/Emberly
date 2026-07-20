import type { ParsedWorkOrder } from "./types";
import { calendarDaysBetween } from "./time";

/**
 * Callback analytics — persisted-path port of the Swift callback panel. The
 * server's callback engine precomputes matches (callback_status +
 * callback_matched_work_order_id); this module only joins, attributes, and
 * ranks. A "callback" is any non-make-ready order flagged possible/confirmed,
 * open or closed alike.
 */

/** Mode membership, local by design (spec'd per module; do not import filters). */
const OPEN_STATUSES = ["Open", "In Progress", "Not Started", "On Hold", "Submitted", "Scheduled"];
const CLOSED_STATUSES = ["Closed", "Completed", "Cancelled", "Canceled"];

const CALLBACK_SIGNALS = new Set(["possible", "confirmed"]);
const COMPLETED_STATUSES = new Set(["Completed", "Closed"]);
/** The office account files tickets but doesn't turn wrenches — Swift excluded
 *  it from per-technician rates (details still show it). */
const EXCLUDED_TECHNICIAN = "ben bloch";

export interface CallbackTechnicianMetric {
  technician: string;
  callbackCount: number;
  completedCount: number;
  /** callbacks / completions; 0 when the technician has no completions. */
  callbackRate: number;
  /** Under 10 completions the rate is noise — UI flags it. */
  hasSmallSample: boolean;
}

export interface CallbackDetail {
  callbackId: string;
  callbackNumber: string;
  /** wo.status of the callback ticket itself (not the callback_status flag). */
  callbackStatus: string;
  unitNumber: string;
  title: string;
  originalId: string | null;
  originalNumber: string | null;
  /** Days from the original's completion to the callback's report; null when
   *  the match or either date is missing. */
  gapDays: number | null;
  /** Attributed technician: the ORIGINAL's tech when matched (they own the
   *  callback), else the callback's own. */
  technician: string;
  isOpen: boolean;
}

export interface CallbackAnalytics {
  metrics: CallbackTechnicianMetric[];
  details: CallbackDetail[];
  detailsByTechnician: Map<string, CallbackDetail[]>;
  /** Total completions across all technicians (the rate denominator pool). */
  completedBase: number;
  callbackTotal: number;
  highestRate: CallbackTechnicianMetric | null;
}

/** Workflow rank for detail sorting: open statuses in order, closed after. */
function statusSortRank(status: string): number {
  const openIndex = OPEN_STATUSES.indexOf(status);
  if (openIndex >= 0) return openIndex;
  const closedIndex = CLOSED_STATUSES.indexOf(status);
  if (closedIndex >= 0) return closedIndex + 10;
  return 99;
}

export function buildCallbackAnalytics(input: { workOrders: ParsedWorkOrder[]; nowMs: number }): CallbackAnalytics {
  const rows = input.workOrders.filter((wo) => !wo.isMakeReady);

  // Completion denominators: every Completed/Closed order with a real (raw
  // non-blank) technician — blank rows would all pool under "Unassigned" and
  // fabricate a rate for nobody.
  const completedCountsByTechnician = new Map<string, number>();
  let completedBase = 0;
  for (const wo of rows) {
    if (!COMPLETED_STATUSES.has(wo.status)) continue;
    if (wo.technician.trim().length === 0) continue;
    completedCountsByTechnician.set(
      wo.technicianDisplay,
      (completedCountsByTechnician.get(wo.technicianDisplay) ?? 0) + 1,
    );
    completedBase += 1;
  }

  const byId = new Map<string, ParsedWorkOrder>();
  for (const wo of rows) byId.set(wo.id, wo);

  const details: CallbackDetail[] = [];
  const callbackCountsByTechnician = new Map<string, number>();
  for (const wo of rows) {
    if (!CALLBACK_SIGNALS.has(wo.callbackStatus)) continue;
    const original = wo.callbackMatchedId.length > 0 ? (byId.get(wo.callbackMatchedId) ?? null) : null;
    const technician = original !== null ? original.technicianDisplay : wo.technicianDisplay;
    const gapDays =
      original !== null && original.completedAt !== null && wo.reportedAt !== null
        ? Math.max(calendarDaysBetween(original.completedAt, wo.reportedAt), 0)
        : null;
    details.push({
      callbackId: wo.id,
      callbackNumber: wo.number,
      callbackStatus: wo.status,
      unitNumber: wo.unitNumber,
      title: wo.title,
      originalId: original?.id ?? null,
      originalNumber: original?.number ?? null,
      gapDays,
      technician,
      isOpen: OPEN_STATUSES.includes(wo.status) && !wo.isMakeReady,
    });
    if (technician.trim().toLowerCase() !== EXCLUDED_TECHNICIAN) {
      callbackCountsByTechnician.set(technician, (callbackCountsByTechnician.get(technician) ?? 0) + 1);
    }
  }

  const metrics: CallbackTechnicianMetric[] = [...callbackCountsByTechnician.entries()]
    .map(([technician, callbackCount]) => {
      const completedCount = completedCountsByTechnician.get(technician) ?? 0;
      return {
        technician,
        callbackCount,
        completedCount,
        callbackRate: completedCount > 0 ? callbackCount / completedCount : 0,
        hasSmallSample: completedCount < 10,
      };
    })
    .filter((m) => m.callbackCount > 0);
  metrics.sort((a, b) => {
    if (a.callbackRate !== b.callbackRate) return b.callbackRate - a.callbackRate;
    if (a.callbackCount !== b.callbackCount) return b.callbackCount - a.callbackCount;
    if (a.completedCount !== b.completedCount) return b.completedCount - a.completedCount;
    return a.technician.localeCompare(b.technician);
  });

  details.sort((a, b) => {
    if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
    const rankA = statusSortRank(a.callbackStatus);
    const rankB = statusSortRank(b.callbackStatus);
    if (rankA !== rankB) return rankA - rankB;
    const gapA = a.gapDays ?? Number.POSITIVE_INFINITY;
    const gapB = b.gapDays ?? Number.POSITIVE_INFINITY;
    if (gapA !== gapB) return gapA - gapB;
    const unitCompare = a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true });
    if (unitCompare !== 0) return unitCompare;
    return a.callbackNumber.localeCompare(b.callbackNumber, undefined, { numeric: true });
  });

  const detailsByTechnician = new Map<string, CallbackDetail[]>();
  for (const detail of details) {
    const list = detailsByTechnician.get(detail.technician);
    if (list) list.push(detail);
    else detailsByTechnician.set(detail.technician, [detail]);
  }

  return {
    metrics,
    details,
    detailsByTechnician,
    completedBase,
    callbackTotal: details.length,
    highestRate: metrics[0] ?? null,
  };
}
