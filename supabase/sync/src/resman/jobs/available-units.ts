/**
 * ResMan available-units sync job: authenticate → fetch the Available Units
 * report → parse the sectioned CSV → enrich existing resman_units rows
 * (lease term, move-out/available dates, old lease id, leasing agent). Never
 * deletes and never rewrites the clean `number`. Port of the orchestration
 * around ResManAvailableUnits + ResManAvailableUnitsImporter.
 */
import { upsertMirror, type ServiceClient } from "../../db/client";
import type { ResManClient } from "../client";
import type { ResManCredentials } from "../config";
import { decodeCsvRows } from "../csv";
import { ResManReportService } from "../report-service";
import { formatAsOfDate } from "../reports/all-units";
import {
  buildAvailableUnitsEndpoint,
  buildAvailableUnitsForm,
  mapAvailableUnitsCsv,
} from "../reports/available-units";

export interface SyncAvailableUnitsParams {
  client: ResManClient;
  supabase: ServiceClient;
  propertyId: string;
  credentials?: ResManCredentials;
  asOf?: Date;
  log?: (message: string) => void;
}

export interface SyncAvailableUnitsResult {
  fetched: number;
  enriched: number;
  duplicates: number;
  repeatedHeaders: number;
  excluded: number;
  skippedNoUnitId: number;
}

export async function syncAvailableUnits(
  params: SyncAvailableUnitsParams,
): Promise<SyncAvailableUnitsResult> {
  const { client, supabase, propertyId } = params;
  const log = params.log ?? (() => {});

  await client.ensureAuthenticated(params.credentials);

  const service = ResManReportService.fromClient(client);
  const endpoint = buildAvailableUnitsEndpoint(client.configuration);
  const context = await service.loadViewerContext(endpoint);
  const asOf = formatAsOfDate(params.asOf ?? new Date());
  const fields = buildAvailableUnitsForm(context, { propertyOrGroupId: propertyId, asOfDate: asOf });
  const bytes = await service.exportCSV(endpoint, fields);

  const { rows } = decodeCsvRows(bytes);
  const result = mapAvailableUnitsCsv(rows, { defaultPropertyId: propertyId });

  // Stamp `synced_at` on every enriched row: this job "saw" the unit even when
  // it changed nothing, and the admin Units page reads max(synced_at) as its
  // "Last sync". Left unset, the column keeps its insert-only default and the
  // page reports a sync from whenever the unit first appeared.
  const syncedAt = new Date().toISOString();
  for (const row of result.mapped) row.synced_at = syncedAt;

  const out = await upsertMirror(supabase, "resman_units", result.mapped, {
    conflictColumn: "resman_unit_id",
  });

  // NO cleared-reset step here (deliberate — unlike syncDelinquency).
  //
  // syncDelinquency safely zeroes units that fall off its report because `balance`
  // is delinquency-owned and "absent from the report" is an unambiguous, self-
  // contained fact ("this resident is no longer delinquent"). None of that holds
  // for the Available Units overlay:
  //
  //  1. move_out_date is NOT an availability overlay. The All Units job
  //     (jobs/units.ts, labelled "authoritative" in jobs/index.ts) is the canonical
  //     writer of move_out_date for EVERY unit — see all-units.ts mapAllUnitsRow,
  //     which sets it from the lease alongside lease_start_date/lease_end_date/
  //     move_in_date. The schema confirms this: move_out_date sits in the core
  //     lease-date block, above the `-- Available Units enrichment` comment that
  //     only covers lease_term/old_lease_id/date_available/leasing_agent. This job
  //     merely re-enriches move_out_date opportunistically. Nulling it for units
  //     off this report would erase authoritative All-Units data and fight that job
  //     on every sync — an outright bug, not a stale-data cleanup.
  //
  //  2. "Absent from this report" != "no longer available". The report includes
  //     still-OCCUPIED sections (Notice to Vacate, Notice to Vacate Pre-Leased,
  //     Under Eviction — see buildAvailableUnitsForm), whose residents are still in
  //     place with firm, still-valid future move-outs and legitimate leasing_agent/
  //     date_available values. Combined with the snapshot as-of date
  //     (RealTimeHistoricalParameter.SingleDate), a unit with a valid but out-of-
  //     window scheduled move-out can be absent from today's export while its
  //     overlay data is still correct. Clearing would erase real leasing data.
  //
  // A reset would only be safe if BOTH were established as product/domain facts:
  //   (a) move_out_date is removed from this job's write set (left solely to All
  //       Units), so the reset touches only the truly availability-owned columns
  //       lease_term/old_lease_id/date_available/leasing_agent; AND
  //   (b) it is confirmed that a unit disappears from THIS report's sections only
  //       when it is genuinely no longer being marketed as available (leased or
  //       notice rescinded) — i.e. the report is not merely date-windowing which
  //       currently-on-notice units it shows as of SingleDate.
  // Until both hold, do not add a cleared-upsert here.

  log(
    `[available-units] dataRows=${result.dataRows} enriched=${out.upserted} ` +
      `duplicates=${result.duplicates} repeatedHeaders=${result.repeatedHeaders} ` +
      `excluded=${result.excluded} skippedNoUnitId=${result.skippedNoUnitId}`,
  );

  return {
    fetched: result.dataRows,
    enriched: out.upserted,
    duplicates: result.duplicates,
    repeatedHeaders: result.repeatedHeaders,
    excluded: result.excluded,
    skippedNoUnitId: result.skippedNoUnitId,
  };
}
