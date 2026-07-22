/**
 * Runnable entry — write today's property snapshot row, once.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   bun run sync:snapshots
 *
 * Reads only the already-synced mirror tables (no ResMan/MLGW scraping), so
 * schedule it as the LAST step of the nightly pipeline — the snapshot should
 * describe the mirror the other jobs just refreshed.
 *
 * IDEMPOTENT: the row is UPSERTed on snapshot_date with source 'nightly', so
 * a same-day re-run simply overwrites today's row with fresher numbers.
 *
 * Optional environment:
 *   PROPERTY_TIME_ZONE  IANA zone for "today" (default America/Chicago)
 */
import { createServiceClient, type ServiceClient } from "./db/client";
import {
  buildPropertySnapshot,
  propertySnapshotDate,
  type SnapshotUnitRow,
  type SnapshotUtilityAccountRow,
  type SnapshotWorkOrderRow,
} from "./snapshots/build";

/** PostgREST caps an unbounded select at 1000 rows; page everything at this size. */
const PAGE = 1000;

/** Page a select through PostgREST's 1000-row window. */
async function readAll<T>(
  supabase: ServiceClient,
  table: string,
  columns: string,
  orderColumn: string,
  refine: (query: any) => any = (q) => q,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await refine(supabase.from(table).select(columns))
      .order(orderColumn, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`read ${table} failed: ${error.message}`);
    const batch = (data ?? []) as unknown as T[];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

async function main(): Promise<void> {
  const env = process.env;
  const supabase = createServiceClient(env);
  const snapshotDate = propertySnapshotDate(new Date(), env.PROPERTY_TIME_ZONE || undefined);

  const [units, workOrders, utilityAccounts] = await Promise.all([
    readAll<SnapshotUnitRow>(
      supabase,
      "resman_units",
      "resman_unit_id, number, occupied, holding_unit, excluded_from_occupancy, " +
        "market_rent, lease_rent, balance, current_month_balance, last_month_balance, " +
        "period_balance, previous_balance, delinquency_reason",
      "resman_unit_id",
    ),
    // Open orders only — the builder re-checks, but the terminal set dwarfs
    // the open set and none of it contributes to the snapshot.
    readAll<SnapshotWorkOrderRow>(
      supabase,
      "resman_work_orders",
      "unit_number, status, is_make_ready",
      "resman_work_order_id",
      (q) => q.not("status", "in", "(Completed,Closed,Canceled)"),
    ),
    readAll<SnapshotUtilityAccountRow>(supabase, "mlgw_accounts", "due_now", "id"),
  ]);

  const row = buildPropertySnapshot({ units, workOrders, utilityAccounts, snapshotDate });

  const { error } = await supabase
    .from("property_snapshots")
    .upsert([row], { onConflict: "snapshot_date" });
  if (error) throw new Error(`upsert property_snapshots failed: ${error.message}`);

  console.log("[run-snapshots] complete:", JSON.stringify(row));
}

main().catch((error) => {
  console.error("[run-snapshots] failed:", error);
  process.exit(1);
});
