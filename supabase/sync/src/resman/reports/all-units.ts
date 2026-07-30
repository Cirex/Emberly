/**
 * ResMan "All Units" report — endpoint, export form, and CSV → resman_units
 * mapper. 1:1 port of iOS ResManAllUnits.swift + ResManUnitImporter.swift.
 *
 * Two deliberate deviations from the Swift, forced by the resman_units schema:
 *  - occupancy_status has a CHECK of ('Occupied','Vacant','Notice'); the Swift
 *    4-value enum (Occupied/Vacant/NTV/Eviction) folds NTV *and* Eviction into
 *    'Notice'.
 *  - lease_status has a CHECK; ResMan's values are already in it, but any value
 *    outside the allowed set is coerced to null rather than failing the insert.
 *  - rows with an empty UnitId are skipped (the DB PK resman_unit_id must be
 *    non-empty); the Swift kept these keyed by unit number.
 */
import type { ResManConfiguration } from "../config";
import { CsvHeaderLookup, normalizeCsvDate, parseBool, parseDouble, parseInt10 } from "../csv";
import { normalizeTenantNames } from "../normalize";
import {
  ResManReportFormBuilder,
  type ResManReportEndpoint,
  type ResManReportPageContext,
} from "../report-service";

export const ALL_UNITS = {
  reportName: "All Units",
  viewerPath: "Reports/AllUnits",
  exportPath: "Reports/GetAllUnitsReport",
  exportType: "Source Data (CSV) w/ IDs",
  errorDomain: "ResManAllUnits",
  logName: "all-units",
} as const;

export function buildAllUnitsEndpoint(config: ResManConfiguration): ResManReportEndpoint {
  const base = config.consumerStartUrl; // trailing slash, used as a base URL
  return {
    viewerUrl: new URL(ALL_UNITS.viewerPath, base).toString(),
    exportUrl: new URL(ALL_UNITS.exportPath, base).toString(),
    errorDomain: ALL_UNITS.errorDomain,
    logName: ALL_UNITS.logName,
  };
}

/** The report's "as of" date, formatted "M/d/yyyy h:mm:ss a" (matches iOS). */
export function formatAsOfDate(date: Date): string {
  const h24 = date.getHours();
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()} ` +
    `${h12}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${ampm}`
  );
}

export function buildAllUnitsForm(
  context: ResManReportPageContext,
  opts: { propertyOrGroupId: string; asOfDate: string; appendProjectLabels?: boolean },
): Array<[string, string]> {
  const builder = new ResManReportFormBuilder(context, ALL_UNITS.reportName, opts.propertyOrGroupId);
  builder.append("SingleDateParameter.SingleDate", opts.asOfDate);
  builder.append("SingleDateParameter.HideHigher", "");
  builder.appendCheckbox("AppendProjectLabelsParameter.Value", opts.appendProjectLabels ?? false);
  return builder.finish(ALL_UNITS.exportType);
}

// ---- mapping helpers --------------------------------------------------------

const KNOWN_CLASSIFICATIONS = new Set(["ruby", "diamond", "legacy", "lux"]);

const ALLOWED_LEASE_STATUS = new Set([
  "Current",
  "Under Eviction",
  "Notice to Vacate",
  "Month to Month",
  "Pending",
  "Pending Renewal",
  "Cancelled",
]);

// Temporary placeholder/holding units to skip (iOS ResManTemporaryUnitExclusions).
export const EXCLUDED_UNIT_NUMBERS = new Set([
  "1x1 lux",
  "1x1 ruby",
  "2x1.5 ruby",
  "3x2 diamond",
  "3x2 ruby",
  "4x2 ruby",
]);

export function normalizeForExclusion(unit: string): string {
  return unit.trim().replace(/\s+/g, " ").toLowerCase();
}

/** True when this unit number is a temporary/placeholder unit to skip. */
export function shouldExcludeUnitNumber(unit: string): boolean {
  return EXCLUDED_UNIT_NUMBERS.has(normalizeForExclusion(unit));
}

function capitalizeWord(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1).toLowerCase();
}

/** UnitTypeName → { layout, classification }. Port of parseUnitTypeName. */
export function parseUnitTypeName(raw: string): { layout: string; classification: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { layout: "", classification: "Legacy" };
  const tokens = trimmed.split(/\s+/);
  const last = tokens[tokens.length - 1];
  if (!KNOWN_CLASSIFICATIONS.has(last.toLowerCase())) {
    return { layout: trimmed, classification: "Legacy" };
  }
  let layout = tokens.slice(0, -1).join(" ");
  const classification = last.toLowerCase() === "lux" ? "LUX" : capitalizeWord(last);
  if (layout.length === 0) layout = trimmed;
  return { layout, classification };
}

/** LeaseStatus + Vacant → the schema's 3-value occupancy. */
export function deriveOccupancy(leaseStatus: string, vacant: boolean): "Occupied" | "Vacant" | "Notice" {
  const s = leaseStatus.trim().toLowerCase();
  if (s === "under eviction" || s === "notice to vacate") return "Notice";
  return vacant ? "Vacant" : "Occupied";
}

export interface MapRowContext {
  defaultPropertyId: string;
  sourceUrl: string;
  scrapedAt: string;
}

/**
 * Map one All-Units CSV data row to a resman_units row, or null when the row
 * should be skipped (fully blank, no unit number, excluded placeholder, or —
 * for the DB port — no UnitId).
 */
export function mapAllUnitsRow(
  lookup: CsvHeaderLookup,
  row: string[],
  ctx: MapRowContext,
): Record<string, unknown> | null {
  if (row.every((cell) => cell.trim().length === 0)) return null;

  const number = lookup.value(row, "Unit");
  if (number.length === 0) return null;
  if (EXCLUDED_UNIT_NUMBERS.has(normalizeForExclusion(number))) return null;

  const unitId = lookup.value(row, "UnitId");
  if (unitId.length === 0) return null; // resman_unit_id (PK) must be non-empty

  const { classification } = parseUnitTypeName(lookup.value(row, "UnitTypeName"));
  const vacant = parseBool(lookup.value(row, "Vacant"));
  const leaseStatusRaw = lookup.value(row, "LeaseStatus");

  return {
    resman_unit_id: unitId,
    resman_property_id: lookup.value(row, "PropertyID") || ctx.defaultPropertyId,
    number,
    classification,
    availability: lookup.value(row, "UnitStatus"),
    lease_status: ALLOWED_LEASE_STATUS.has(leaseStatusRaw) ? leaseStatusRaw : null,
    occupancy_status: deriveOccupancy(leaseStatusRaw, vacant),
    occupied: !vacant,
    current_lease_id: lookup.value(row, "CurrentLeaseId") || null,
    pending_lease_id: lookup.value(row, "PendingLeaseID") || null,
    market_rent: parseDouble(lookup.value(row, "MarketRent")),
    lease_rent: parseDouble(lookup.value(row, "ActualRent")),
    deposit_held: parseDouble(lookup.value(row, "DepositPaidIn")),
    bedrooms: parseInt10(lookup.value(row, "Bedrooms")),
    bathrooms: parseDouble(lookup.value(row, "Bathrooms")),
    holding_unit: parseBool(lookup.value(row, "IsHoldingUnit")),
    excluded_from_occupancy: parseBool(lookup.value(row, "ExcludedFromOccupancy")),
    move_in_date: normalizeCsvDate(lookup.value(row, "MoveInDate")),
    move_out_date: normalizeCsvDate(lookup.value(row, "MoveOutDate")),
    lease_start_date: normalizeCsvDate(lookup.value(row, "LeaseStartDate")),
    lease_end_date: normalizeCsvDate(lookup.value(row, "LeaseEndDate")),
    notes: lookup.value(row, "Description"),
    tenant_names: normalizeTenantNames(lookup.value(row, "Residents")),
    source_url: ctx.sourceUrl,
    scraped_at: ctx.scrapedAt,
    // `synced_at` too, not just `scraped_at`. resman_units is the only mirror
    // table carrying both, and `synced_at` was left to its column default —
    // which an ON CONFLICT DO UPDATE never re-applies, so it froze at the last
    // INSERT (i.e. the last time a brand-new unit appeared) while the rows
    // themselves refreshed every run. The admin Units page reads
    // max(synced_at), so it reported a sync weeks old on current data.
    // Every other ResMan table means "the scraper saw this row" by `synced_at`;
    // units now agrees. `scraped_at` stays as the narrower "last All-Units pass".
    synced_at: ctx.scrapedAt,
  };
}
