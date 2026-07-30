/**
 * ResMan units sync job: authenticate → fetch the All-Units report → parse →
 * map → upsert into resman_units (property-scoped delete-missing), seeding the
 * resman_properties FK from the report's own property columns.
 *
 * Design §3.3. Port of the orchestration around ResManAllUnits +
 * ResManUnitImporter.
 */
import { upsertMirror, type ServiceClient } from "../../db/client";
import type { ResManClient } from "../client";
import type { ResManCredentials } from "../config";
import { CsvHeaderLookup, decodeCsvRows } from "../csv";
import { ResManReportService } from "../report-service";
import {
  buildAllUnitsEndpoint,
  buildAllUnitsForm,
  formatAsOfDate,
  mapAllUnitsRow,
} from "../reports/all-units";

export interface SyncUnitsParams {
  client: ResManClient;
  supabase: ServiceClient;
  /** ResMan property id the report filters on (PropertyOrGroupIDs). */
  propertyId: string;
  credentials?: ResManCredentials;
  asOf?: Date;
  log?: (message: string) => void;
}

export interface SyncUnitsResult {
  fetched: number;
  mapped: number;
  skipped: number;
  unitsUpserted: number;
  unitsDeletedStale: number;
  propertiesUpserted: number;
}

export async function syncUnits(params: SyncUnitsParams): Promise<SyncUnitsResult> {
  const { client, supabase, propertyId } = params;
  const log = params.log ?? (() => {});

  await client.ensureAuthenticated(params.credentials);

  const service = ResManReportService.fromClient(client);
  const endpoint = buildAllUnitsEndpoint(client.configuration);
  const context = await service.loadViewerContext(endpoint);
  const asOf = formatAsOfDate(params.asOf ?? new Date());
  const fields = buildAllUnitsForm(context, { propertyOrGroupId: propertyId, asOfDate: asOf });
  const bytes = await service.exportCSV(endpoint, fields);

  const { rows } = decodeCsvRows(bytes);
  if (rows.length < 2) {
    log(`[units] report returned no data rows`);
    return { fetched: 0, mapped: 0, skipped: 0, unitsUpserted: 0, unitsDeletedStale: 0, propertiesUpserted: 0 };
  }

  const headers = rows[0];
  const lookup = new CsvHeaderLookup(headers);
  const dataRows = rows.slice(1);
  const scrapedAt = new Date().toISOString();
  const accountId = client.configuration.accountId;

  const unitRows: Array<Record<string, unknown>> = [];
  let skipped = 0;
  for (const row of dataRows) {
    const mapped = mapAllUnitsRow(lookup, row, {
      defaultPropertyId: propertyId,
      sourceUrl: endpoint.viewerUrl,
      scrapedAt,
    });
    if (!mapped) {
      skipped += 1;
      continue;
    }
    mapped.raw = Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""]));
    unitRows.push(mapped);
  }

  // Seed the resman_properties FK from the CSV's distinct properties (minimal;
  // never overwrites the user-owned custom_name column). The full properties
  // sync is a separate report/job.
  const propsById = new Map<string, Record<string, unknown>>();
  for (const row of dataRows) {
    const pid = lookup.value(row, "PropertyID") || propertyId;
    if (pid.length === 0 || propsById.has(pid)) continue;
    propsById.set(pid, {
      resman_property_id: pid,
      resman_account_id: accountId,
      name: lookup.value(row, "PropertyName"),
      // Same insert-only trap as resman_units: without this the column keeps
      // its default and freezes at first insert.
      synced_at: scrapedAt,
    });
  }
  const propOut = await upsertMirror(supabase, "resman_properties", [...propsById.values()], {
    conflictColumn: "resman_property_id",
  });

  const unitOut = await upsertMirror(supabase, "resman_units", unitRows, {
    conflictColumn: "resman_unit_id",
    deleteMissing: true,
    deleteScope: { column: "resman_property_id", value: propertyId },
  });

  log(
    `[units] fetched=${dataRows.length} mapped=${unitRows.length} skipped=${skipped} ` +
      `upserted=${unitOut.upserted} deletedStale=${unitOut.deletedStale} properties=${propOut.upserted}`,
  );

  return {
    fetched: dataRows.length,
    mapped: unitRows.length,
    skipped,
    unitsUpserted: unitOut.upserted,
    unitsDeletedStale: unitOut.deletedStale,
    propertiesUpserted: propOut.upserted,
  };
}
