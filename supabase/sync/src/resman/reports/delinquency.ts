/**
 * ResMan "Delinquency with Aging" report — endpoint, accounting-period
 * resolution, export form, date helpers, and CSV → resman_units balance
 * enrichment mapper. 1:1 port of iOS ResManDelinquency.swift +
 * ResManDelinquencyImporter.swift.
 *
 * The report is keyed by an accounting period whose id must be scraped from the
 * viewer HTML's <option> list (matched by label, e.g. "July 2026"). The importer
 * matches CSV rows to existing units by unit *number* — exact match only, to
 * avoid writing a balance to the wrong unit — so the job resolves number →
 * resman_unit_id before upserting.
 */
import type { ResManConfiguration } from "../config";
import { CsvHeaderLookup, parseDouble, parseInt10 } from "../csv";
import {
  ResManReportFormBuilder,
  type ResManReportEndpoint,
  type ResManReportPageContext,
} from "../report-service";

export const DELINQUENCY = {
  reportName: "Delinquency with Aging",
  viewerPath: "Reports/DelinquencywithAging",
  exportPath: "Reports/GetDelinquencywithAgingReport",
  exportType: "Source Data (CSV) w/ IDs",
  errorDomain: "ResManDelinquency",
  logName: "delinquency",
} as const;

export const DEFAULT_DELINQUENCY_LEASE_STATUSES = [
  "Pending",
  "Cancelled",
  "Current",
  "Month to Month",
  "Notice to Vacate",
  "Former",
  "Denied",
  "Under Eviction",
  "Evicted",
] as const;

export const DEFAULT_DELINQUENCY_OTHER_ACCOUNTS = [
  "Prospect",
  "Non-Resident Account",
  "WOIT Account",
] as const;

export function buildDelinquencyEndpoint(config: ResManConfiguration): ResManReportEndpoint {
  const base = config.consumerStartUrl;
  return {
    viewerUrl: new URL(DELINQUENCY.viewerPath, base).toString(),
    exportUrl: new URL(DELINQUENCY.exportPath, base).toString(),
    errorDomain: DELINQUENCY.errorDomain,
    logName: DELINQUENCY.logName,
  };
}

// ---- accounting period + date helpers ---------------------------------------

export interface AccountingPeriod {
  id: string;
  label: string;
}

const OPTION_RE = /<option\b[^>]*\bvalue="([^"]*)"[^>]*>\s*([^<]+?)\s*<\/option>/gi;

/** Extract `<option value="id">label</option>` pairs from the viewer HTML. */
export function extractAccountingPeriods(html: string): AccountingPeriod[] {
  const result: AccountingPeriod[] = [];
  for (const match of html.matchAll(OPTION_RE)) {
    result.push({ id: match[1], label: match[2] });
  }
  return result;
}

/** Resolve the accounting-period id whose label matches (case-insensitive). */
export function resolveAccountingPeriodId(html: string, label: string): string {
  const periods = extractAccountingPeriods(html);
  const hit = periods.find((p) => p.label.toLowerCase() === label.toLowerCase());
  if (!hit) {
    const preview = periods
      .slice(0, 8)
      .map((p) => `${p.label}=${p.id}`)
      .join(", ");
    throw new Error(
      `[${DELINQUENCY.errorDomain}] Could not find accounting period '${label}'. Available: [${preview}]`,
    );
  }
  return hit.id;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Accounting-period label, e.g. "July 2026" (Swift `MMMM yyyy`). */
export function accountingPeriodLabel(date: Date): string {
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** Format a date as `MM/dd/yyyy` (Swift `MM/dd/yyyy`). */
export function formatMMDDYYYY(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()}`;
}

export function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function monthEnd(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

export function buildDelinquencyForm(
  context: ResManReportPageContext,
  opts: {
    propertyOrGroupId: string;
    accountingPeriodId: string;
    accountingPeriodLabel: string;
    startDate: string;
    endDate: string;
    leaseStatuses?: readonly string[];
    otherAccounts?: readonly string[];
    minimumBalance?: string;
    maximumBalance?: string;
  },
): Array<[string, string]> {
  const builder = new ResManReportFormBuilder(context, DELINQUENCY.reportName, opts.propertyOrGroupId);
  builder.appendMany([
    ["PeriodOrDateRangeParameter.DateType", "Period"],
    ["PeriodOrDateRangeParameter.AccountingPeriodID", opts.accountingPeriodId],
    ["PeriodOrDateRangeParameter_AccountingPeriodIDInput", opts.accountingPeriodLabel],
    ["PeriodOrDateRangeParameter.StartDate", opts.startDate],
    ["PeriodOrDateRangeParameter.EndDate", opts.endDate],
  ]);
  builder.appendRepeated(
    "LeaseStatusesParameter.SelectedItems",
    [...(opts.leaseStatuses ?? DEFAULT_DELINQUENCY_LEASE_STATUSES)],
  );
  builder.appendRepeated(
    "OtherAccountsParameter.SelectedItems",
    [...(opts.otherAccounts ?? DEFAULT_DELINQUENCY_OTHER_ACCOUNTS)],
  );
  builder.append("MinimumBalanceParameter.Value", opts.minimumBalance ?? "0.00");
  builder.append("MaximumBalanceParameter.Value", opts.maximumBalance ?? "0.00");
  return builder.finish(DELINQUENCY.exportType);
}

// ---- row mapping ------------------------------------------------------------

export interface DelinquencyRow {
  /** The unit number the report keys on (resolved to a unit id by the job). */
  unitReference: string;
  /** The balance columns to enrich (no unit-id/property-id keys yet). */
  values: Record<string, unknown>;
}

/**
 * Map one Delinquency CSV row to its unit reference + balance values, or null
 * when the row is blank or has no Unit reference.
 */
export function mapDelinquencyRow(lookup: CsvHeaderLookup, row: string[]): DelinquencyRow | null {
  if (row.every((cell) => cell.trim().length === 0)) return null;
  const unitReference = lookup.value(row, "Unit");
  if (unitReference.length === 0) return null;

  return {
    unitReference,
    values: {
      balance: parseDouble(lookup.value(row, "TotalBalance")),
      current_month_balance: parseDouble(lookup.value(row, "Balance0to30")),
      last_month_balance: parseDouble(lookup.value(row, "Balance31to60")),
      period_balance: parseDouble(lookup.value(row, "PeriodBalance")),
      previous_balance: parseDouble(lookup.value(row, "PreviousBalance")),
      times_late: parseInt10(lookup.value(row, "TimesLate")),
      delinquency_reason: lookup.value(row, "DelinquencyReason") || null,
    },
  };
}
