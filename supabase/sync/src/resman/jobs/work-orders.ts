/**
 * ResMan work-orders sync job: authenticate → fetch the Work Order Summary
 * report → map → upsert into resman_work_orders (property-scoped delete-missing).
 * Resolves resman_unit_id from the unit number for "Unit" work orders. Port of
 * the orchestration around ResManWorkOrderScraper.
 *
 * After the upsert, freshly-inserted Emergency work orders in an open status
 * are pushed to every registered maintenance-app device (shared/push.ts).
 * The whole notification pass is best-effort — it can never fail the sync.
 */
import { upsertMirror, type ServiceClient } from "../../db/client";
import {
  buildEmergencyPushMessages,
  detectNewEmergencies,
  sendExpoPushMessages,
} from "../../shared/push";
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
  /** New Emergency work orders for which a push notification was attempted. */
  emergenciesNotified: number;
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

/**
 * Page the property's existing work-order ids so the post-upsert pass can tell
 * newly-inserted rows from refreshed ones. Returns null on failure — the
 * notification pass is skipped rather than misfiring or failing the sync.
 */
async function loadExistingWorkOrderIds(
  supabase: ServiceClient,
  propertyId: string,
  log: (message: string) => void,
): Promise<Set<string> | null> {
  try {
    const ids = new Set<string>();
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from("resman_work_orders")
        .select("resman_work_order_id")
        .eq("resman_property_id", propertyId)
        .order("resman_work_order_id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw new Error(error.message);
      const batch = (data ?? []) as unknown as Array<{ resman_work_order_id: string }>;
      for (const row of batch) ids.add(row.resman_work_order_id);
      if (batch.length < pageSize) break;
    }
    return ids;
  } catch (error) {
    log(
      `[work-orders] WARNING: reading existing work-order ids failed, skipping emergency ` +
        `notifications: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * Best-effort emergency push pass: detect newly-inserted open Emergency work
 * orders, fan one push per active maintenance-app device out via Expo, and
 * deactivate tokens Expo reports as DeviceNotRegistered. Never throws.
 */
async function notifyNewEmergencies(
  supabase: ServiceClient,
  existingIds: Set<string>,
  rows: Array<Record<string, unknown>>,
  log: (message: string) => void,
): Promise<number> {
  try {
    const emergencies = detectNewEmergencies(existingIds, rows);
    if (emergencies.length === 0) return 0;

    const { data, error } = await supabase
      .from("push_tokens")
      .select("expo_push_token")
      .eq("active", true)
      .eq("app", "maintenance");
    if (error) throw new Error(`read push_tokens failed: ${error.message}`);
    const tokens = ((data ?? []) as unknown as Array<{ expo_push_token: string }>)
      .map((row) => row.expo_push_token)
      .filter((token) => token.length > 0);
    if (tokens.length === 0) {
      log(`[work-orders] ${emergencies.length} new emergency(ies) but no active push tokens`);
      return emergencies.length;
    }

    const messages = emergencies.flatMap((wo) => buildEmergencyPushMessages(wo, tokens));
    const outcome = await sendExpoPushMessages(messages, { log });
    log(
      `[work-orders] emergency push: workOrders=${emergencies.length} devices=${tokens.length} ` +
        `sent=${outcome.sent} failed=${outcome.failed} invalidTokens=${outcome.invalidTokens.length}`,
    );

    if (outcome.invalidTokens.length > 0) {
      const { error: deactivateError } = await supabase
        .from("push_tokens")
        .update({ active: false })
        .in("expo_push_token", outcome.invalidTokens);
      if (deactivateError) {
        log(`[work-orders] WARNING: deactivating stale push tokens failed: ${deactivateError.message}`);
      }
    }
    return emergencies.length;
  } catch (error) {
    log(
      `[work-orders] WARNING: emergency push notification pass failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  }
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
    return { fetched: 0, mapped: 0, upserted: 0, deletedStale: 0, linkedUnits: 0, emergenciesNotified: 0 };
  }

  const lookup = new CsvHeaderLookup(rows[0]);
  const dataRows = rows.slice(1);
  const unitIdByNumber = await loadUnitNumberIndex(supabase, propertyId);
  // Snapshot the mirror's ids before the upsert so newly-inserted rows are
  // detectable afterwards (null = read failed → skip notifications).
  const existingIds = await loadExistingWorkOrderIds(supabase, propertyId, log);

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

  const emergenciesNotified =
    existingIds === null ? 0 : await notifyNewEmergencies(supabase, existingIds, woRows, log);

  log(
    `[work-orders] fetched=${dataRows.length} mapped=${woRows.length} upserted=${out.upserted} ` +
      `deletedStale=${out.deletedStale} linkedUnits=${linkedUnits} emergenciesNotified=${emergenciesNotified}`,
  );

  return {
    fetched: dataRows.length,
    mapped: woRows.length,
    upserted: out.upserted,
    deletedStale: out.deletedStale,
    linkedUnits,
    emergenciesNotified,
  };
}
