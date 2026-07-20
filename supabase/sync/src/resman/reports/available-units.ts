/**
 * ResMan "Available Units" report — endpoint, export form, and CSV → resman_units
 * enrichment mapper. 1:1 port of iOS ResManAvailableUnits.swift +
 * ResManAvailableUnitsImporter.swift.
 *
 * Unlike All Units, this report is *sectioned* (Vacant / Notice to Vacate /
 * Holding Units / …), so the CSV carries repeated header rows and the real
 * header may not be row 0. The importer therefore: locates the header row by
 * scanning for a unit-id/number column, skips repeated header rows, and
 * de-duplicates identical data rows. Header matching strips spaces (ResMan
 * emits both "UnitID" and "Unit ID" variants), so this uses its own normalizer.
 *
 * It only *enriches* rows the All Units job already created — it never updates
 * the clean `number` (the report can append project labels) and, for the DB
 * port, skips rows without a UnitId (resman_unit_id is the PK).
 */
import type { ResManConfiguration } from "../config";
import { CsvHeaderLookup, normalizeCsvDate } from "../csv";
import {
  ResManReportFormBuilder,
  type ResManReportEndpoint,
  type ResManReportPageContext,
} from "../report-service";
import { formatAsOfDate, shouldExcludeUnitNumber } from "./all-units";

export const AVAILABLE_UNITS = {
  reportName: "Available Units",
  viewerPath: "Reports/AvailableUnits",
  exportPath: "Reports/GetAvailableUnitsReport",
  exportType: "Source Data (CSV) w/ IDs",
  errorDomain: "ResManAvailableUnits",
  logName: "available-units",
} as const;

export function buildAvailableUnitsEndpoint(config: ResManConfiguration): ResManReportEndpoint {
  const base = config.consumerStartUrl;
  return {
    viewerUrl: new URL(AVAILABLE_UNITS.viewerPath, base).toString(),
    exportUrl: new URL(AVAILABLE_UNITS.exportPath, base).toString(),
    errorDomain: AVAILABLE_UNITS.errorDomain,
    logName: AVAILABLE_UNITS.logName,
  };
}

export function buildAvailableUnitsForm(
  context: ResManReportPageContext,
  opts: {
    propertyOrGroupId: string;
    asOfDate: string;
    mergeParents?: boolean;
    appendUnitNumbersWithProjectLabel?: boolean;
  },
): Array<[string, string]> {
  const builder = new ResManReportFormBuilder(context, AVAILABLE_UNITS.reportName, opts.propertyOrGroupId);
  builder.appendMany([
    ["RealTimeHistoricalParameter.Source", "Realtime"],
    ["RealTimeHistoricalParameter.DateType", "DateRange"],
    ["RealTimeHistoricalParameter.SingleDate", opts.asOfDate],
    ["UnitStatusParameter.SelectedItems", "Ready"],
    ["UnitStatusParameter.SelectedItems", "Not Ready"],
    ["LeaseTermsParameter.Value", "False"],
    ["SortByParameter.Value", "UnitType"],
    ["OnlyOnlineMarketingParameter.Value", "false"],
  ]);
  builder.appendCheckbox("MergeParentsParameter.Value", opts.mergeParents ?? true);
  builder.appendCheckbox(
    "AppendUnitNumbersWithProjectLabelParameter.Value",
    opts.appendUnitNumbersWithProjectLabel ?? true,
  );
  builder.appendMany([
    ["ReportSectionsParameter.SelectedItems", "Vacant"],
    ["ReportSectionsParameter.SelectedItems", "Notice to Vacate"],
    ["ReportSectionsParameter.SelectedItems", "Vacant Pre-Leased"],
    ["ReportSectionsParameter.SelectedItems", "Notice to Vacate Pre-Leased"],
    ["ReportSectionsParameter.SelectedItems", "Holding Units"],
    ["ReportSectionsParameter.SelectedItems", "Under Eviction"],
  ]);
  return builder.finish(AVAILABLE_UNITS.exportType);
}

// ---- header normalization + column name candidates --------------------------

const BOM = /﻿/g;
const NBSP = / /g;

/** Space-stripping header normalizer (port of the importer's normalizeHeaderName). */
export function stripSpacesNormalizer(value: string): string {
  return value.replace(BOM, "").replace(NBSP, " ").trim().replace(/\s+/g, "").toLowerCase();
}

const UNIT_ID_NAMES = ["UnitID", "UnitId", "Unit ID", "Unit Id"];
const UNIT_NUMBER_NAMES = ["Unit", "Number", "UnitNumber", "Unit Number"];
const PROPERTY_ID_NAMES = ["PropertyID", "PropertyId"];
const OLD_LEASE_ID_NAMES = ["OldLeaseID", "OldLeaseId"];
const DATE_AVAILABLE_NAMES = ["UnitDateAvailable", "DateAvailable"];
const LEASING_AGENT_NAMES = ["LeasingAgentLastName", "Leasing Agent Last Name", "LeasingAgent"];

/**
 * Locate the header row: the first row that contains a unit-id or unit-number
 * column. Returns -1 when none is found. Port of the `firstIndex(where:)` scan.
 */
export function findUnitHeaderRowIndex(rows: string[][]): number {
  const wanted = new Set([...UNIT_ID_NAMES, ...UNIT_NUMBER_NAMES].map(stripSpacesNormalizer));
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].some((cell) => wanted.has(stripSpacesNormalizer(cell)))) return i;
  }
  return -1;
}

function isRepeatedHeaderRow(row: string[], headers: string[]): boolean {
  if (row.length < headers.length) return false;
  return headers.every((h, i) => stripSpacesNormalizer(row[i]) === stripSpacesNormalizer(h));
}

function rowSignature(row: string[], columnCount: number): string {
  const parts: string[] = [];
  for (let i = 0; i < columnCount; i += 1) {
    const cell = i < row.length ? row[i] : "";
    parts.push(cell.replace(BOM, "").replace(NBSP, " ").trim());
  }
  return parts.join("");
}

export interface AvailableUnitsContext {
  defaultPropertyId: string;
}

export interface AvailableUnitsResult {
  /** Enrichment rows keyed by resman_unit_id (uniform column set for upsert). */
  mapped: Array<Record<string, unknown>>;
  dataRows: number;
  duplicates: number;
  repeatedHeaders: number;
  excluded: number;
  /** Rows dropped because they had no UnitId (cannot target the PK). */
  skippedNoUnitId: number;
}

/**
 * Parse the full Available Units CSV into enrichment rows. Handles the sectioned
 * layout (header detection, repeated-header + duplicate + blank skipping,
 * temporary-unit exclusion) and maps only the columns actually present so the
 * upsert never overwrites an absent column with null.
 */
export function mapAvailableUnitsCsv(
  rows: string[][],
  ctx: AvailableUnitsContext,
): AvailableUnitsResult {
  const headerRowIndex = findUnitHeaderRowIndex(rows);
  if (headerRowIndex < 0) {
    return { mapped: [], dataRows: 0, duplicates: 0, repeatedHeaders: 0, excluded: 0, skippedNoUnitId: 0 };
  }

  const headers = rows[headerRowIndex];
  const lookup = new CsvHeaderLookup(headers, stripSpacesNormalizer);
  const dataRows = rows.slice(headerRowIndex + 1);

  const firstValue = (row: string[], names: string[]): string => {
    for (const name of names) {
      const v = lookup.value(row, name);
      if (v.length > 0) return v;
    }
    return "";
  };

  // Which optional columns the report carries — decided once so every emitted
  // row has the same key set (required for a single PostgREST upsert).
  const hasLeaseTerm = lookup.has("LeaseTerm");
  const hasMoveOut = lookup.has("MoveOutDate");
  const hasOldLease = lookup.hasAny(OLD_LEASE_ID_NAMES);
  const hasDateAvailable = lookup.hasAny(DATE_AVAILABLE_NAMES);
  const hasLeasingAgent = lookup.hasAny(LEASING_AGENT_NAMES);

  const mapped: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let repeatedHeaders = 0;
  let excluded = 0;
  let skippedNoUnitId = 0;

  for (const row of dataRows) {
    if (row.every((cell) => cell.trim().length === 0)) continue;
    if (isRepeatedHeaderRow(row, headers)) {
      repeatedHeaders += 1;
      continue;
    }
    const signature = rowSignature(row, headers.length);
    if (seen.has(signature)) {
      duplicates += 1;
      continue;
    }
    seen.add(signature);

    const unitNumber = firstValue(row, UNIT_NUMBER_NAMES);
    const unitId = firstValue(row, UNIT_ID_NAMES);
    if (unitId.length === 0 && unitNumber.length === 0) continue;
    if (unitNumber.length > 0 && shouldExcludeUnitNumber(unitNumber)) {
      excluded += 1;
      continue;
    }
    if (unitId.length === 0) {
      skippedNoUnitId += 1;
      continue; // resman_unit_id (PK) required to enrich
    }

    const out: Record<string, unknown> = {
      resman_unit_id: unitId,
      resman_property_id: firstValue(row, PROPERTY_ID_NAMES) || ctx.defaultPropertyId,
    };
    if (hasLeaseTerm) out.lease_term = lookup.value(row, "LeaseTerm") || null;
    if (hasMoveOut) out.move_out_date = normalizeCsvDate(lookup.value(row, "MoveOutDate"));
    if (hasOldLease) out.old_lease_id = firstValue(row, OLD_LEASE_ID_NAMES) || null;
    if (hasDateAvailable) out.date_available = normalizeCsvDate(firstValue(row, DATE_AVAILABLE_NAMES));
    if (hasLeasingAgent) out.leasing_agent = firstValue(row, LEASING_AGENT_NAMES) || null;
    mapped.push(out);
  }

  return {
    mapped,
    dataRows: dataRows.length,
    duplicates,
    repeatedHeaders,
    excluded,
    skippedNoUnitId,
  };
}
