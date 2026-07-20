/**
 * ResMan work-orders sync job: authenticate → fetch the Work Order Summary
 * report → map → upsert into resman_work_orders (property-scoped delete-missing).
 * Resolves resman_unit_id from the unit number for "Unit" work orders. Port of
 * the orchestration around ResManWorkOrderScraper.
 */
import { upsertMirror, type ServiceClient } from "../../db/client";
import type { ResManClient } from "../client";
import type { ResManCredentials } from "../config";
import { CsvHeaderLookup, decodeCsvRows } from "../csv";
import { ResManReportService } from "../report-service";
import {
  buildWorkOrdersEndpoint,
  buildWorkOrdersForm,
  firstAccountingPeriod,
  formatWorkOrderDate,
  mapWorkOrderRow,
} from "../reports/work-orders";

export interface SyncWorkOrdersParams {
  client: ResManClient;
  supabase: ServiceClient;
  propertyId: string;
  credentials?: ResManCredentials;
  /** Report window (defaults: startDate 01/01/2024 → today). */
  startDate?: string;
  endDate?: Date;
  log?: (message: string) => void;
}

export interface SyncWorkOrdersResult {
  fetched: number;
  mapped: number;
  upserted: number;
  deletedStale: number;
  linkedUnits: number;
}

/** Page the property's units into a unit-number → resman_unit_id map. */
async function loadUnitNumberIndex(
  supabase: ServiceClient,
  propertyId: string,
): Promise<Map<string, string>> {
  const byNumber = new Map<string, string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("resman_units")
      .select("resman_unit_id, number")
      .eq("resman_property_id", propertyId)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`read resman_units failed: ${error.message}`);
    const batch = (data ?? []) as unknown as Array<{ resman_unit_id: string; number: string }>;
    for (const u of batch) {
      const key = (u.number ?? "").trim();
      if (key.length > 0 && !byNumber.has(key)) byNumber.set(key, u.resman_unit_id);
    }
    if (batch.length < pageSize) break;
  }
  return byNumber;
}

export async function syncWorkOrders(params: SyncWorkOrdersParams): Promise<SyncWorkOrdersResult> {
  const { client, supabase, propertyId } = params;
  const log = params.log ?? (() => {});
  const startDate = params.startDate ?? "01/01/2024";
  const endDate = formatWorkOrderDate(params.endDate ?? new Date());

  await client.ensureAuthenticated(params.credentials);

  const service = ResManReportService.fromClient(client);
  const endpoint = buildWorkOrdersEndpoint(client.configuration);
  const context = await service.loadViewerContext(endpoint);
  const period = firstAccountingPeriod(context.html);
  const fields = buildWorkOrdersForm(context, {
    propertyOrGroupId: propertyId,
    startDate,
    endDate,
    accountingPeriodId: period.id,
    accountingPeriodLabel: period.label,
  });
  const bytes = await service.exportCSV(endpoint, fields);

  const { rows } = decodeCsvRows(bytes);
  if (rows.length < 2) {
    log(`[work-orders] report returned no data rows`);
    return { fetched: 0, mapped: 0, upserted: 0, deletedStale: 0, linkedUnits: 0 };
  }

  const lookup = new CsvHeaderLookup(rows[0]);
  const dataRows = rows.slice(1);
  const unitIdByNumber = await loadUnitNumberIndex(supabase, propertyId);

  const woRows: Array<Record<string, unknown>> = [];
  let linkedUnits = 0;
  for (const row of dataRows) {
    const mapped = mapWorkOrderRow(lookup, row, { propertyId, unitIdByNumber });
    if (!mapped) continue;
    if (mapped.resman_unit_id !== null) linkedUnits += 1;
    mapped.raw = Object.fromEntries(rows[0].map((h, i) => [h, row[i] ?? ""]));
    woRows.push(mapped);
  }

  const out = await upsertMirror(supabase, "resman_work_orders", woRows, {
    conflictColumn: "resman_work_order_id",
    deleteMissing: true,
    deleteScope: { column: "resman_property_id", value: propertyId },
  });

  log(
    `[work-orders] fetched=${dataRows.length} mapped=${woRows.length} upserted=${out.upserted} ` +
      `deletedStale=${out.deletedStale} linkedUnits=${linkedUnits}`,
  );

  return {
    fetched: dataRows.length,
    mapped: woRows.length,
    upserted: out.upserted,
    deletedStale: out.deletedStale,
    linkedUnits,
  };
}
