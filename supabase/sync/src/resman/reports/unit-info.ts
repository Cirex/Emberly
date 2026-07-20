/**
 * ResMan "Unit Info" report — endpoint, export form, and CSV → resman_units
 * enrichment mapper. 1:1 port of iOS ResManUnitInfo.swift +
 * ResManUnitInfoImporter.swift.
 *
 * Enriches existing resman_units rows with address, floor, accessibility flags,
 * pending-lease details, deposit, and max occupancy, and seeds resman_buildings
 * from the report's BuildingId/BuildingName so resman_building_id can be linked.
 * Header row is row 0 (unsectioned). Rows without a UnitId are skipped
 * (resman_unit_id is the PK); the clean `number` is left to the All Units job.
 */
import type { ResManConfiguration } from "../config";
import { CsvHeaderLookup, normalizeCsvDate, parseBool, parseDouble, parseInt10 } from "../csv";
import {
  ResManReportFormBuilder,
  type ResManReportEndpoint,
  type ResManReportPageContext,
} from "../report-service";
import { shouldExcludeUnitNumber } from "./all-units";

export const UNIT_INFO = {
  reportName: "Unit Info",
  viewerPath: "Reports/UnitInfo",
  exportPath: "Reports/GetUnitInfoReport",
  exportType: "Source Data (CSV) w/ IDs",
  errorDomain: "ResManUnitInfo",
  logName: "unitinfo",
} as const;

export function buildUnitInfoEndpoint(config: ResManConfiguration): ResManReportEndpoint {
  const base = config.consumerStartUrl;
  return {
    viewerUrl: new URL(UNIT_INFO.viewerPath, base).toString(),
    exportUrl: new URL(UNIT_INFO.exportPath, base).toString(),
    errorDomain: UNIT_INFO.errorDomain,
    logName: UNIT_INFO.logName,
  };
}

export function buildUnitInfoForm(
  context: ResManReportPageContext,
  opts: { propertyOrGroupId: string },
): Array<[string, string]> {
  const builder = new ResManReportFormBuilder(context, UNIT_INFO.reportName, opts.propertyOrGroupId);
  return builder.finish(UNIT_INFO.exportType);
}

/**
 * Normalize a street address, moving a trailing unit marker into "Apt N" form.
 * Port of `ResManUnitInfoImporter.standardizedStreetAddress`.
 */
export function standardizedStreetAddress(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return "";
  const aptMarker = collapsed.replace(/\bapt\.?\s*#\s*([A-Za-z0-9-]+)\s*$/i, "Apt $1");
  return aptMarker.replace(/\s*#\s*([A-Za-z0-9-]+)\s*$/, " Apt $1");
}

export interface UnitInfoContext {
  defaultPropertyId: string;
}

export interface UnitInfoMapped {
  unit: Record<string, unknown>;
  /** Building to seed into resman_buildings, or null when the row has no BuildingId. */
  building: Record<string, unknown> | null;
}

/**
 * Map one Unit Info CSV row to a resman_units enrichment row (+ optional building
 * seed), or null when the row should be skipped (blank, no unit id, excluded).
 * Only columns present in the header set are written, so the batch upsert has a
 * uniform key set and never overwrites an absent column with null.
 */
export function mapUnitInfoRow(
  lookup: CsvHeaderLookup,
  row: string[],
  ctx: UnitInfoContext,
): UnitInfoMapped | null {
  if (row.every((cell) => cell.trim().length === 0)) return null;

  const unitId = lookup.value(row, "UnitID") || lookup.value(row, "UnitId");
  const unitNumber = lookup.value(row, "Number");
  if (unitId.length === 0 && unitNumber.length === 0) return null;
  if (unitNumber.length > 0 && shouldExcludeUnitNumber(unitNumber)) return null;
  if (unitId.length === 0) return null; // resman_unit_id (PK) required to enrich

  const propertyId = lookup.value(row, "PropertyID") || ctx.defaultPropertyId;

  const unit: Record<string, unknown> = {
    resman_unit_id: unitId,
    resman_property_id: propertyId,
  };

  const buildingId = lookup.value(row, "BuildingId");
  let building: Record<string, unknown> | null = null;
  if (lookup.has("BuildingId")) {
    unit.resman_building_id = buildingId || null;
    if (buildingId.length > 0) {
      building = {
        resman_building_id: buildingId,
        resman_property_id: propertyId,
        name: lookup.value(row, "BuildingName"),
      };
    }
  }

  if (lookup.has("StreetAddress")) unit.street = standardizedStreetAddress(lookup.value(row, "StreetAddress"));
  if (lookup.has("City")) unit.city = lookup.value(row, "City");
  if (lookup.has("State")) unit.state = lookup.value(row, "State");
  if (lookup.has("Zip")) unit.postal_code = lookup.value(row, "Zip");
  if (lookup.has("Floor")) unit.floor = lookup.value(row, "Floor") || null;
  if (lookup.has("AvailableForOnlineMarketing"))
    unit.available_for_online_marketing = parseBool(lookup.value(row, "AvailableForOnlineMarketing"));
  if (lookup.has("HearingAccessible"))
    unit.hearing_accessible = parseBool(lookup.value(row, "HearingAccessible"));
  if (lookup.has("MobilityAccessible"))
    unit.mobility_accessible = parseBool(lookup.value(row, "MobilityAccessible"));
  if (lookup.has("VisualAccessible"))
    unit.visual_accessible = parseBool(lookup.value(row, "VisualAccessible"));
  if (lookup.has("RequiredDeposit"))
    unit.deposit_required = parseDouble(lookup.value(row, "RequiredDeposit"));
  if (lookup.has("PendingLeaseId")) unit.pending_lease_id = lookup.value(row, "PendingLeaseId") || null;
  if (lookup.has("PendingMoveInDate"))
    unit.pending_move_in_date = normalizeCsvDate(lookup.value(row, "PendingMoveInDate"));
  if (lookup.has("PendingLeaseStartDate"))
    unit.pending_lease_start_date = normalizeCsvDate(lookup.value(row, "PendingLeaseStartDate"));
  if (lookup.has("PendingLeaseEndDate"))
    unit.pending_lease_end_date = normalizeCsvDate(lookup.value(row, "PendingLeaseEndDate"));
  if (lookup.has("UnitTypeMaxOccupancy"))
    unit.max_occupancy = parseInt10(lookup.value(row, "UnitTypeMaxOccupancy"));

  return { unit, building };
}
