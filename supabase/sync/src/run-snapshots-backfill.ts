/**
 * Runnable entry — ONE-SHOT backfill of daily occupancy snapshots from lease
 * spans, 24 months back from today.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   bun run sync:snapshots:backfill
 *
 * The "Honest backfill" rule (approved Trends design): occupancy history can
 * be reconstructed from resman_leases start/end spans, so those rows are
 * written full-depth with source 'backfill' — but ONLY the occupancy-family
 * columns; balances/turns/utility stay null because their history does not
 * exist anywhere. Rows are inserted with ignoreDuplicates on snapshot_date,
 * so an existing row — today's 'nightly' row, or a previous backfill run —
 * is NEVER overwritten. Safe to re-run.
 *
 * Optional environment:
 *   PROPERTY_TIME_ZONE           IANA zone for "today" (default America/Chicago)
 *   SNAPSHOT_BACKFILL_MONTHS     window depth in months (default 24)
 */
import { createServiceClient, type ServiceClient } from "./db/client";
import { buildOccupancyBackfill, type LeaseSpanRow } from "./snapshots/backfill";
import { countsForOccupancy, propertySnapshotDate } from "./snapshots/build";

/** PostgREST caps an unbounded select at 1000 rows; page everything at this size. */
const PAGE = 1000;
const UPSERT_BATCH = 500;

/** Page a select through PostgREST's 1000-row window. */
async function readAll<T>(
  supabase: ServiceClient,
  table: string,
  columns: string,
  orderColumn: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order(orderColumn, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`read ${table} failed: ${error.message}`);
    const batch = (data ?? []) as unknown as T[];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

/** "YYYY-MM-DD" exactly `months` calendar months before the given ISO date. */
function monthsBeforeIso(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 - months, d)).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const env = process.env;
  const supabase = createServiceClient(env);

  const months = Number(env.SNAPSHOT_BACKFILL_MONTHS ?? "24");
  if (!Number.isInteger(months) || months <= 0) {
    throw new Error(`SNAPSHOT_BACKFILL_MONTHS must be a positive integer, got "${env.SNAPSHOT_BACKFILL_MONTHS}"`);
  }
  const toDate = propertySnapshotDate(new Date(), env.PROPERTY_TIME_ZONE || undefined);
  const fromDate = monthsBeforeIso(toDate, months);

  const [leases, units] = await Promise.all([
    readAll<LeaseSpanRow>(
      supabase,
      "resman_leases",
      "resman_unit_id, unit_number, status, approval_status, start_date, end_date, " +
        "move_in_date, move_out_date, is_current_lease",
      "resman_lease_id",
    ),
    readAll<{ excluded_from_occupancy: boolean | null; holding_unit: boolean | null }>(
      supabase,
      "resman_units",
      "excluded_from_occupancy, holding_unit",
      "resman_unit_id",
    ),
  ]);

  // Denominator: today's counted-unit total (the mirror has no unit-count
  // history and the property's inventory is fixed) — documented in
  // snapshots/backfill.ts.
  const totalUnits = units.filter(countsForOccupancy).length;

  const rows = buildOccupancyBackfill({ leases, fromDate, toDate, totalUnits });
  if (rows.length === 0) {
    console.log("[run-snapshots-backfill] nothing to write (empty window or no leases)");
    return;
  }

  // ignoreDuplicates: existing rows (nightly or earlier backfill) always win.
  let inserted = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const chunk = rows.slice(i, i + UPSERT_BATCH);
    const { data, error } = await supabase
      .from("property_snapshots")
      .upsert(chunk, { onConflict: "snapshot_date", ignoreDuplicates: true })
      .select("snapshot_date");
    if (error) throw new Error(`backfill upsert property_snapshots failed: ${error.message}`);
    inserted += ((data ?? []) as unknown[]).length;
  }

  console.log(
    `[run-snapshots-backfill] complete: window=${fromDate}..${toDate} days=${rows.length} ` +
      `inserted=${inserted} skippedExisting=${rows.length - inserted} totalUnits=${totalUnits}`,
  );
}

main().catch((error) => {
  console.error("[run-snapshots-backfill] failed:", error);
  process.exit(1);
});
