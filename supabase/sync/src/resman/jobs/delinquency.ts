/**
 * ResMan delinquency sync job: authenticate → resolve the accounting period from
 * the viewer HTML → fetch the Delinquency with Aging report → match rows to
 * existing units by unit *number* (exact) → enrich resman_units balances (total,
 * aging buckets, times-late, reason). Never deletes; skips unmatched units. Port
 * of the orchestration around ResManDelinquency + ResManDelinquencyImporter.
 */
import { upsertMirror, type ServiceClient } from "../../db/client";
import type { ResManClient } from "../client";
import type { ResManCredentials } from "../config";
import { CsvHeaderLookup, decodeCsvRows } from "../csv";
import { ResManReportService } from "../report-service";
import {
  accountingPeriodLabel,
  buildDelinquencyEndpoint,
  buildDelinquencyForm,
  formatMMDDYYYY,
  mapDelinquencyRow,
  monthEnd,
  monthStart,
  resolveAccountingPeriodId,
} from "../reports/delinquency";

export interface SyncDelinquencyParams {
  client: ResManClient;
  supabase: ServiceClient;
  propertyId: string;
  credentials?: ResManCredentials;
  /** Defaults to the current month (period label, start, end all derived). */
  asOf?: Date;
  accountingPeriodLabel?: string;
  startDate?: string;
  endDate?: string;
  log?: (message: string) => void;
}

export interface SyncDelinquencyResult {
  fetched: number;
  enriched: number;
  unmatched: number;
  /** Units reset to a zero balance because they dropped off the report. */
  cleared: number;
  period: string;
}

/** The "not delinquent" state — written to units that fell off the report. */
const CLEARED_DELINQUENCY_VALUES = {
  balance: 0,
  current_month_balance: 0,
  last_month_balance: 0,
  period_balance: 0,
  previous_balance: 0,
  times_late: 0,
  delinquency_reason: null,
} as const;

/**
 * Units that currently carry a positive balance but are ABSENT from the fresh
 * delinquency report — i.e. residents who have paid off since the last sync.
 * Their stale balance/aging columns are reset to zero. Scoped to the property
 * and to units that actually have a balance, so it is never a wholesale wipe;
 * the caller only invokes it when the report returned real rows.
 */
async function buildClearedDelinquencyRows(
  supabase: ServiceClient,
  propertyId: string,
  stillDelinquent: Set<string>,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("resman_units")
      .select("resman_unit_id")
      .eq("resman_property_id", propertyId)
      .gt("balance", 0)
      .order("resman_unit_id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`read delinquent units failed: ${error.message}`);
    const batch = (data ?? []) as unknown as Array<{ resman_unit_id: string }>;
    for (const u of batch) {
      if (!stillDelinquent.has(u.resman_unit_id)) {
        rows.push({
          resman_unit_id: u.resman_unit_id,
          resman_property_id: propertyId,
          ...CLEARED_DELINQUENCY_VALUES,
        });
      }
    }
    if (batch.length < pageSize) break;
  }
  return rows;
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

export async function syncDelinquency(params: SyncDelinquencyParams): Promise<SyncDelinquencyResult> {
  const { client, supabase, propertyId } = params;
  const log = params.log ?? (() => {});
  const now = params.asOf ?? new Date();
  const label = params.accountingPeriodLabel ?? accountingPeriodLabel(now);
  const startDate = params.startDate ?? formatMMDDYYYY(monthStart(now));
  const endDate = params.endDate ?? formatMMDDYYYY(monthEnd(now));

  await client.ensureAuthenticated(params.credentials);

  const service = ResManReportService.fromClient(client);
  const endpoint = buildDelinquencyEndpoint(client.configuration);
  const context = await service.loadViewerContext(endpoint);
  const accountingPeriodId = resolveAccountingPeriodId(context.html, label);
  const fields = buildDelinquencyForm(context, {
    propertyOrGroupId: propertyId,
    accountingPeriodId,
    accountingPeriodLabel: label,
    startDate,
    endDate,
  });
  const bytes = await service.exportCSV(endpoint, fields);

  const { rows } = decodeCsvRows(bytes);
  if (rows.length < 2) {
    log(`[delinquency] report returned no data rows (period ${label})`);
    // No reset here on purpose: an empty report can't be distinguished from a
    // broken fetch, so we never mass-zero balances off a report with no rows.
    return { fetched: 0, enriched: 0, unmatched: 0, cleared: 0, period: label };
  }

  const lookup = new CsvHeaderLookup(rows[0]);
  const dataRows = rows.slice(1);
  const unitByNumber = await loadUnitNumberIndex(supabase, propertyId);

  const enrichRows: Array<Record<string, unknown>> = [];
  let unmatched = 0;
  for (const row of dataRows) {
    const mapped = mapDelinquencyRow(lookup, row);
    if (!mapped) continue;
    const unitId = unitByNumber.get(mapped.unitReference.trim());
    if (!unitId) {
      unmatched += 1;
      continue; // exact-match only — never write a balance to the wrong unit
    }
    enrichRows.push({
      resman_unit_id: unitId,
      resman_property_id: propertyId,
      ...mapped.values,
    });
  }

  const out = await upsertMirror(supabase, "resman_units", enrichRows, {
    conflictColumn: "resman_unit_id",
  });

  // Zero out units that paid off since last sync (present in the DB with a
  // balance, absent from this report). Safe because we only get here when the
  // report returned real data rows (the empty/broken-fetch case returned above).
  const stillDelinquent = new Set(enrichRows.map((r) => r.resman_unit_id as string));
  const clearedRows = await buildClearedDelinquencyRows(supabase, propertyId, stillDelinquent);
  const cleared = clearedRows.length
    ? (await upsertMirror(supabase, "resman_units", clearedRows, { conflictColumn: "resman_unit_id" })).upserted
    : 0;

  log(
    `[delinquency] period=${label} dataRows=${dataRows.length} enriched=${out.upserted} unmatched=${unmatched} cleared=${cleared}`,
  );

  return { fetched: dataRows.length, enriched: out.upserted, unmatched, cleared, period: label };
}
