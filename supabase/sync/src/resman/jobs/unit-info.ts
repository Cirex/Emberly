/**
 * ResMan unit-info sync job: authenticate → fetch the Unit Info report → parse →
 * seed resman_buildings from the report's BuildingId/BuildingName → enrich
 * existing resman_units rows (address, floor, accessibility, pending-lease
 * details, deposit, max occupancy). Never deletes. Port of the orchestration
 * around ResManUnitInfo + ResManUnitInfoImporter.
 */
import { upsertMirror, type ServiceClient } from "../../db/client";
import type { ResManClient } from "../client";
import type { ResManCredentials } from "../config";
import { CsvHeaderLookup, decodeCsvRows } from "../csv";
import { ResManReportService } from "../report-service";
import { buildUnitInfoEndpoint, buildUnitInfoForm, mapUnitInfoRow } from "../reports/unit-info";

export interface SyncUnitInfoParams {
  client: ResManClient;
  supabase: ServiceClient;
  propertyId: string;
  credentials?: ResManCredentials;
  log?: (message: string) => void;
}

export interface SyncUnitInfoResult {
  fetched: number;
  enriched: number;
  buildingsUpserted: number;
  skipped: number;
}

export async function syncUnitInfo(params: SyncUnitInfoParams): Promise<SyncUnitInfoResult> {
  const { client, supabase, propertyId } = params;
  const log = params.log ?? (() => {});

  await client.ensureAuthenticated(params.credentials);

  const service = ResManReportService.fromClient(client);
  const endpoint = buildUnitInfoEndpoint(client.configuration);
  const context = await service.loadViewerContext(endpoint);
  const fields = buildUnitInfoForm(context, { propertyOrGroupId: propertyId });
  const bytes = await service.exportCSV(endpoint, fields);

  const { rows } = decodeCsvRows(bytes);
  if (rows.length < 2) {
    log(`[unit-info] report returned no data rows`);
    return { fetched: 0, enriched: 0, buildingsUpserted: 0, skipped: 0 };
  }

  const lookup = new CsvHeaderLookup(rows[0]);
  const dataRows = rows.slice(1);

  const unitRows: Array<Record<string, unknown>> = [];
  const buildingsById = new Map<string, Record<string, unknown>>();
  let skipped = 0;
  for (const row of dataRows) {
    const mapped = mapUnitInfoRow(lookup, row, { defaultPropertyId: propertyId });
    if (!mapped) {
      skipped += 1;
      continue;
    }
    unitRows.push(mapped.unit);
    if (mapped.building) {
      const id = String(mapped.building.resman_building_id);
      if (!buildingsById.has(id)) buildingsById.set(id, mapped.building);
    }
  }

  // Buildings first — resman_units.resman_building_id FKs into resman_buildings.
  const buildingOut = await upsertMirror(supabase, "resman_buildings", [...buildingsById.values()], {
    conflictColumn: "resman_building_id",
  });
  const unitOut = await upsertMirror(supabase, "resman_units", unitRows, {
    conflictColumn: "resman_unit_id",
  });

  log(
    `[unit-info] dataRows=${dataRows.length} enriched=${unitOut.upserted} ` +
      `buildings=${buildingOut.upserted} skipped=${skipped}`,
  );

  return {
    fetched: dataRows.length,
    enriched: unitOut.upserted,
    buildingsUpserted: buildingOut.upserted,
    skipped,
  };
}
