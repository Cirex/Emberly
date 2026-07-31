/**
 * Runnable entry — write today's PER-UNIT snapshot rows, once.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   bun run sync:unit-snapshots
 *
 * The sibling of run-snapshots.ts. That one writes a single property-level row
 * per day; this writes one row per unit, which is the difference between
 * "occupancy was 64% in June" and "1727 LP-3 has been vacant since March".
 *
 * The ResMan mirror UPSERTS current state, so resman_units has no past at all.
 * Without this table every per-unit question about time — days vacant, turnover
 * count, a balance climbing for three months — is unanswerable, and worse,
 * looks answerable because the property-level trend works.
 *
 * Reads only the already-synced mirror, so schedule it in the same slot as
 * run-snapshots: LAST, after the jobs that refresh what it describes.
 *
 * IDEMPOTENT: rows are UPSERTed on (snapshot_date, resman_unit_id), so a
 * same-day re-run overwrites today's rows with fresher numbers rather than
 * duplicating them.
 *
 * Optional environment:
 *   PROPERTY_TIME_ZONE  IANA zone for "today" (default America/Chicago)
 */
import { createServiceClient, type ServiceClient } from "./db/client";
import { propertySnapshotDate } from "./snapshots/build";

/** PostgREST caps an unbounded select at 1000 rows; page everything at this size. */
const PAGE = 1000;

/** Rows per upsert request. Keeps the payload well inside any body limit. */
const WRITE_CHUNK = 500;

interface UnitRow {
  resman_unit_id: string;
  number: string | null;
  resman_building_id: string | null;
  resman_floorplan_id: string | null;
  occupancy_status: string | null;
  occupied: boolean | null;
  lease_status: string | null;
  availability: string | null;
  balance: number | null;
  current_month_balance: number | null;
  market_rent: number | null;
  lease_rent: number | null;
  times_late: number | null;
  holding_unit: boolean | null;
  excluded_from_occupancy: boolean | null;
  move_in_date: string | null;
  move_out_date: string | null;
  lease_end_date: string | null;
}

const COLUMNS = [
  "resman_unit_id", "number", "resman_building_id", "resman_floorplan_id",
  "occupancy_status", "occupied", "lease_status", "availability",
  "balance", "current_month_balance", "market_rent", "lease_rent", "times_late",
  "holding_unit", "excluded_from_occupancy",
  "move_in_date", "move_out_date", "lease_end_date",
].join(", ");

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

/** Project a mirror row onto a history row for `snapshotDate`. */
export function buildUnitSnapshot(unit: UnitRow, snapshotDate: string) {
  return {
    snapshot_date: snapshotDate,
    resman_unit_id: unit.resman_unit_id,
    // Denormalised on purpose: a renumbered unit must not silently rewrite its
    // own history, which is what reading through to the mirror would do.
    unit_number: unit.number,
    resman_building_id: unit.resman_building_id,
    resman_floorplan_id: unit.resman_floorplan_id,
    occupancy_status: unit.occupancy_status,
    occupied: unit.occupied,
    lease_status: unit.lease_status,
    availability: unit.availability,
    balance: unit.balance,
    current_month_balance: unit.current_month_balance,
    market_rent: unit.market_rent,
    lease_rent: unit.lease_rent,
    times_late: unit.times_late,
    // Carried per row so an occupancy RATE stays computable for a PAST date.
    // Reading today's flags to judge last March would quietly restate history.
    holding_unit: unit.holding_unit,
    excluded_from_occupancy: unit.excluded_from_occupancy,
    move_in_date: unit.move_in_date,
    move_out_date: unit.move_out_date,
    lease_end_date: unit.lease_end_date,
    source: "nightly",
  };
}

async function main(): Promise<void> {
  const env = process.env;
  const supabase = createServiceClient(env);
  const snapshotDate = propertySnapshotDate(new Date(), env.PROPERTY_TIME_ZONE || undefined);

  const units = await readAll<UnitRow>(supabase, "resman_units", COLUMNS, "resman_unit_id");
  if (units.length === 0) {
    // Writing nothing is right, but doing it silently would make a broken
    // upstream sync look like a successful run.
    console.warn("[run-unit-snapshots] no units in the mirror — writing nothing");
    return;
  }

  const rows = units.map((unit) => buildUnitSnapshot(unit, snapshotDate));
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const { error } = await supabase
      .from("unit_snapshots")
      .upsert(rows.slice(i, i + WRITE_CHUNK), { onConflict: "snapshot_date,resman_unit_id" });
    if (error) throw new Error(`upsert unit_snapshots failed: ${error.message}`);
  }

  const occupied = rows.filter((r) => r.occupied === true).length;
  console.log(
    `[run-unit-snapshots] complete: ${rows.length} units for ${snapshotDate} (${occupied} occupied)`,
  );
}

main().catch((error) => {
  console.error("[run-unit-snapshots] failed:", error);
  process.exit(1);
});
