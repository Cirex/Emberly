/**
 * ResMan "Work Order Summary" report — endpoint, export form, and CSV →
 * resman_work_orders mapper. 1:1 port of iOS/Kraken ResManWorkOrderSync.swift
 * (ResManWorkOrderScraper + parseCSV).
 *
 * Like Delinquency, the export needs an accounting-period id even for a
 * DateRange run — but here the *first* GUID-valued period option is used (not a
 * label match). Report statuses are folded into the resman_work_orders CHECK set
 * and priorities are coerced to the allowed set (default 'Normal').
 */
import type { ResManConfiguration } from "../config";
import { CsvHeaderLookup, normalizeCsvDate, parseBool } from "../csv";
import {
  ResManReportFormBuilder,
  type ResManReportEndpoint,
  type ResManReportPageContext,
} from "../report-service";

export const WORK_ORDERS = {
  reportName: "Work Order Summary",
  viewerPath: "Reports/WorkOrderSummary",
  exportPath: "Reports/GetWorkOrderSummaryReport",
  exportType: "Source Data (CSV) w/ IDs",
  errorDomain: "ResManWorkOrders",
  logName: "work-orders",
} as const;

const REPORT_STATUSES = [
  "Submitted",
  "Not Started",
  "Scheduled",
  "In Progress",
  "Completed",
  "Cancelled",
  "Closed",
  "On Hold",
] as const;

export function buildWorkOrdersEndpoint(config: ResManConfiguration): ResManReportEndpoint {
  const base = config.consumerStartUrl;
  return {
    viewerUrl: new URL(WORK_ORDERS.viewerPath, base).toString(),
    exportUrl: new URL(WORK_ORDERS.exportPath, base).toString(),
    errorDomain: WORK_ORDERS.errorDomain,
    logName: WORK_ORDERS.logName,
  };
}

/** First GUID-valued `<option>` (id + label) in the viewer HTML. Port of `extractAccountingPeriods().first`. */
export function firstAccountingPeriod(html: string): { id: string; label: string } {
  const regex = /<option[^>]+value="([0-9a-fA-F-]{36})"[^>]*>\s*([^<]+?)\s*<\/option>/i;
  const match = regex.exec(html);
  if (match === null) return { id: "", label: "" };
  return { id: match[1], label: match[2] };
}

/** Format a date as `MM/dd/yyyy`. */
export function formatWorkOrderDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()}`;
}

export function buildWorkOrdersForm(
  context: ResManReportPageContext,
  opts: {
    propertyOrGroupId: string;
    startDate: string;
    endDate: string;
    accountingPeriodId: string;
    accountingPeriodLabel: string;
  },
): Array<[string, string]> {
  const builder = new ResManReportFormBuilder(context, WORK_ORDERS.reportName, opts.propertyOrGroupId);
  builder.appendMany([
    ["PeriodOrDateRangeParameter.DateType", "DateRange"],
    ["PeriodOrDateRangeParameter.AccountingPeriodID", opts.accountingPeriodId],
    ["PeriodOrDateRangeParameter_AccountingPeriodIDInput", opts.accountingPeriodLabel],
    ["PeriodOrDateRangeParameter.StartDate", opts.startDate],
    ["PeriodOrDateRangeParameter.EndDate", opts.endDate],
    ["FilterByParameter.Value", "Reported Date"],
    ["FilterByParameter_ValueInput", "Reported Date"],
  ]);
  builder.appendRepeated("StatusesParameter.SelectedItems", [...REPORT_STATUSES]);
  builder.appendCheckbox("IncludeMakeReadyParameter.Value", true);
  builder.appendCheckbox("IncludeNonMakeReadyParameter.Value", true);
  builder.appendCheckbox("IncludeProjectParameter.Value", true);
  return builder.finish(WORK_ORDERS.exportType);
}

// ---- mapping ----------------------------------------------------------------

const ALLOWED_PRIORITIES = new Set(["Emergency", "High", "Normal", "Low"]);

/** Fold a ResMan report status into the resman_work_orders CHECK set. Port of `workOrderStatus`. */
export function mapWorkOrderStatus(raw: string): string {
  switch (raw.trim().toLowerCase()) {
    case "not started":
      return "Not Started";
    case "scheduled":
      return "Scheduled";
    case "in progress":
      return "In Progress";
    case "completed":
      return "Completed";
    case "closed":
      return "Closed";
    case "cancelled":
    case "canceled":
      return "Canceled";
    // ResMan can report "Submitted" and "On Hold" (both are requested in
    // REPORT_STATUSES), but the resman_work_orders CHECK set has no value for
    // either. "Submitted" folds to "Not Started" (work not yet begun);
    // "On Hold" is the lossy case — it collapses here too. Giving it a distinct
    // status needs a new CHECK value + migration; until then this is explicit
    // rather than silently hitting `default`.
    case "submitted":
    case "on hold":
      return "Not Started";
    default:
      return "Not Started";
  }
}

const PRIORITY_BY_LOWER = new Map([...ALLOWED_PRIORITIES].map((p) => [p.toLowerCase(), p]));

/** Coerce a priority to the allowed set, defaulting to 'Normal'. Port of `WorkOrderPriority(rawValue:) ?? .normal`. */
export function mapWorkOrderPriority(raw: string): string {
  // Case-insensitive: ResMan emits e.g. "EMERGENCY"/"high", and a case-sensitive
  // match would silently downgrade a real emergency to "Normal".
  return PRIORITY_BY_LOWER.get(raw.trim().toLowerCase()) ?? "Normal";
}

export interface MapWorkOrderContext {
  propertyId: string;
  /** unit number → resman_unit_id, to link the FK when ObjectType is "Unit". */
  unitIdByNumber: Map<string, string>;
}

/**
 * Map one Work Order Summary CSV row to a resman_work_orders row, or null when
 * the row has no WorkorderID (the PK). Port of `parseCSV`'s per-row build.
 */
export function mapWorkOrderRow(
  lookup: CsvHeaderLookup,
  row: string[],
  ctx: MapWorkOrderContext,
): Record<string, unknown> | null {
  const id = lookup.value(row, "WorkorderID").trim();
  if (id.length === 0) return null;

  const objectType = lookup.value(row, "ObjectType");
  const unitNumber = lookup.value(row, "ObjectName");
  // ResMan ships a known "Categoty" typo in some report versions.
  const category = lookup.value(row, "Category") || lookup.value(row, "Categoty");

  const resmanUnitId =
    objectType.toLowerCase() === "unit" ? (ctx.unitIdByNumber.get(unitNumber.trim()) ?? null) : null;

  return {
    resman_work_order_id: id,
    number: lookup.value(row, "Number"),
    resman_unit_id: resmanUnitId,
    unit_number: unitNumber,
    resman_property_id: ctx.propertyId,
    status: mapWorkOrderStatus(lookup.value(row, "Status")),
    priority: mapWorkOrderPriority(lookup.value(row, "Priority")),
    category,
    title: lookup.value(row, "Description"),
    notes: lookup.value(row, "Notes"),
    completion_notes: lookup.value(row, "CompletionNotes"),
    technician: lookup.value(row, "AssignedPerson"),
    date_reported: normalizeCsvDate(lookup.value(row, "DateReported")),
    date_scheduled: normalizeCsvDate(lookup.value(row, "ScheduledDate")),
    date_completed: normalizeCsvDate(lookup.value(row, "DateCompleted")),
    // ResMan's MakeReady report flag misses rows whose category is plainly a
    // make-ready ("Make Ready Maintenance", "Turn Maintenance/Punch", …), so
    // fold the category in — the boards downstream key off this flag.
    is_make_ready: parseBool(lookup.value(row, "MakeReady")) || /make.?ready|\bturn\b/i.test(category ?? ""),
  };
}
