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
  buildWorkOrdersChangedMessages,
  detectNewEmergencies,
  sendExpoPushMessages,
  type ExpoAnyPushMessage,
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
  /**
   * Work orders whose content actually changed this pass — the number the
   * silent wake-up push reports, and the number a device's ?updated_since=
   * poll will return. 0 means every device can skip its next fetch entirely.
   */
  changed: number;
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

/** Active maintenance-app device tokens. Throws — callers are best-effort. */
async function loadMaintenancePushTokens(supabase: ServiceClient): Promise<string[]> {
  const { data, error } = await supabase
    .from("push_tokens")
    .select("expo_push_token")
    .eq("active", true)
    .eq("app", "maintenance");
  if (error) throw new Error(`read push_tokens failed: ${error.message}`);
  return ((data ?? []) as unknown as Array<{ expo_push_token: string }>)
    .map((row) => row.expo_push_token)
    .filter((token) => token.length > 0);
}

/** Send, then retire whatever Expo told us is no longer a device. */
async function sendAndPruneTokens(
  supabase: ServiceClient,
  messages: ReadonlyArray<ExpoAnyPushMessage>,
  log: (message: string) => void,
): Promise<{ sent: number; failed: number }> {
  const outcome = await sendExpoPushMessages(messages, { log });
  if (outcome.invalidTokens.length > 0) {
    const { error } = await supabase
      .from("push_tokens")
      .update({ active: false })
      .in("expo_push_token", outcome.invalidTokens);
    if (error) log(`[work-orders] WARNING: deactivating stale push tokens failed: ${error.message}`);
  }
  return { sent: outcome.sent, failed: outcome.failed };
}

/**
 * How many work orders actually changed content this pass.
 *
 * Counted in the DB rather than by diffing the scrape in memory, because the
 * change-detecting updated_at trigger is already the authority — and it is the
 * SAME authority the device's ?updated_since= poll reads. Deriving the push
 * count from anywhere else would let the two disagree, which shows up as a
 * device being told to sync and then finding nothing (or worse, not being told).
 *
 * Returns null when the count can't be read, so the caller skips the push
 * rather than guessing.
 */
async function countChangedSince(
  supabase: ServiceClient,
  propertyId: string,
  since: string,
  log: (message: string) => void,
): Promise<number | null> {
  const { count, error } = await supabase
    .from("resman_work_orders")
    .select("resman_work_order_id", { count: "exact", head: true })
    .eq("resman_property_id", propertyId)
    .gt("updated_at", since);
  if (error) {
    log(`[work-orders] WARNING: counting changed rows failed: ${error.message}`);
    return null;
  }
  return count ?? 0;
}

/**
 * Best-effort silent wake-up: if anything changed, tell every active device
 * once so it runs its sync tick now instead of up to a poll interval later.
 * Never throws — a push problem must not fail the sync.
 */
async function notifyWorkOrdersChanged(
  supabase: ServiceClient,
  changed: number,
  log: (message: string) => void,
): Promise<void> {
  if (changed === 0) {
    log(`[work-orders] nothing changed — no wake-up push`);
    return;
  }
  try {
    const tokens = await loadMaintenancePushTokens(supabase);
    if (tokens.length === 0) return;
    const outcome = await sendAndPruneTokens(
      supabase,
      buildWorkOrdersChangedMessages(tokens, changed),
      log,
    );
    log(
      `[work-orders] wake-up push: changed=${changed} devices=${tokens.length} ` +
        `sent=${outcome.sent} failed=${outcome.failed}`,
    );
  } catch (error) {
    log(
      `[work-orders] WARNING: wake-up push pass failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
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

    const tokens = await loadMaintenancePushTokens(supabase);
    if (tokens.length === 0) {
      log(`[work-orders] ${emergencies.length} new emergency(ies) but no active push tokens`);
      return emergencies.length;
    }

    const messages = emergencies.flatMap((wo) => buildEmergencyPushMessages(wo, tokens));
    const outcome = await sendAndPruneTokens(supabase, messages, log);
    log(
      `[work-orders] emergency push: workOrders=${emergencies.length} devices=${tokens.length} ` +
        `sent=${outcome.sent} failed=${outcome.failed}`,
    );
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
    return {
      fetched: 0, mapped: 0, upserted: 0, deletedStale: 0, linkedUnits: 0,
      emergenciesNotified: 0, changed: 0,
    };
  }

  const lookup = new CsvHeaderLookup(rows[0]);
  const dataRows = rows.slice(1);
  const unitIdByNumber = await loadUnitNumberIndex(supabase, propertyId);
  // Snapshot the mirror's ids before the upsert so newly-inserted rows are
  // detectable afterwards (null = read failed → skip notifications).
  const existingIds = await loadExistingWorkOrderIds(supabase, propertyId, log);

  // One stamp for the whole pass, written to every row.
  //
  // `synced_at` used to be insert-only (a column default), which left
  // max(updated_at) as the de-facto "when did work-orders last sync" signal —
  // it worked only because the unconditional trigger bumped every row. The
  // change-detecting trigger deliberately takes that away, so provenance moves
  // to the column named for it: synced_at = "the scraper saw this row",
  // updated_at = "this row changed". The trigger excludes synced_at from its
  // comparison, so stamping it here cannot defeat the change detection.
  const scrapedAt = new Date().toISOString();

  const woRows: Array<Record<string, unknown>> = [];
  let linkedUnits = 0;
  for (const row of dataRows) {
    const mapped = mapWorkOrderRow(lookup, row, { propertyId, unitIdByNumber });
    if (!mapped) continue;
    if (mapped.resman_unit_id !== null) linkedUnits += 1;
    mapped.raw = Object.fromEntries(rows[0].map((h, i) => [h, row[i] ?? ""]));
    mapped.synced_at = scrapedAt;
    woRows.push(mapped);
  }

  // Mark the instant before the write. Anything the upsert genuinely changes
  // lands with updated_at > this; anything it rewrites unchanged keeps its old
  // timestamp (the change-detecting trigger — see
  // deltas/2026-07-24-work-order-change-detection.sql).
  const upsertMark = new Date().toISOString();

  const out = await upsertMirror(supabase, "resman_work_orders", woRows, {
    conflictColumn: "resman_work_order_id",
    deleteMissing: true,
    deleteScope: { column: "resman_property_id", value: propertyId },
  });

  const emergenciesNotified =
    existingIds === null ? 0 : await notifyNewEmergencies(supabase, existingIds, woRows, log);

  // Anything whose content moved — read back from the trigger's own verdict,
  // using the mark taken before the upsert. A null count means "couldn't tell",
  // which stays silent: a spurious wake-up is cheap but an app that learns to
  // ignore them is not.
  const changed = await countChangedSince(supabase, propertyId, upsertMark, log);
  await notifyWorkOrdersChanged(supabase, changed ?? 0, log);

  log(
    `[work-orders] fetched=${dataRows.length} mapped=${woRows.length} upserted=${out.upserted} ` +
      `deletedStale=${out.deletedStale} linkedUnits=${linkedUnits} ` +
      `emergenciesNotified=${emergenciesNotified} changed=${changed ?? "unknown"}`,
  );

  return {
    fetched: dataRows.length,
    mapped: woRows.length,
    upserted: out.upserted,
    deletedStale: out.deletedStale,
    linkedUnits,
    emergenciesNotified,
    changed: changed ?? 0,
  };
}
