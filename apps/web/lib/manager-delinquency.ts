import type { Database } from "@/types/database";
import type { UntypedSupabase } from "@/lib/supabase/types";

/**
 * Delinquency board feed for the manager app: the resman_units delinquency
 * mirror (populated by the Delinquency-with-Aging report enrichment) filtered
 * to units that currently owe or carry a delinquency note. The companion
 * actions timeline lives in lib/delinquency-actions.ts; the route stitches
 * both into one chunky payload and the phone derives the board.
 */

type UnitRow = Database["public"]["Tables"]["resman_units"]["Row"];

/** The resman_units columns the delinquency payload carries. */
export const DELINQUENT_UNIT_COLUMNS =
  "resman_unit_id, number, tenant_names, balance, current_month_balance, last_month_balance, " +
  "period_balance, previous_balance, times_late, delinquency_reason, leasing_agent, " +
  "current_lease_id, market_rent";

export type DelinquentUnitRow = Pick<
  UnitRow,
  | "resman_unit_id"
  | "number"
  | "tenant_names"
  | "balance"
  | "current_month_balance"
  | "last_month_balance"
  | "period_balance"
  | "previous_balance"
  | "times_late"
  | "delinquency_reason"
  | "leasing_agent"
  | "current_lease_id"
  | "market_rent"
>;

/** A unit belongs on the board when it owes money or carries a reason note. */
export function isDelinquentUnit(
  row: Pick<DelinquentUnitRow, "balance" | "delinquency_reason">,
): boolean {
  if ((row.balance ?? 0) > 0) return true;
  return (row.delinquency_reason ?? "").trim() !== "";
}

/** One delinquent unit, camelCased for the wire. */
export interface DelinquentUnitPayload {
  unitId: string;
  unitNumber: string;
  tenantNames: string[];
  balance: number | null;
  currentMonthBalance: number | null;
  lastMonthBalance: number | null;
  periodBalance: number | null;
  previousBalance: number | null;
  timesLate: number | null;
  delinquencyReason: string;
  leasingAgent: string;
  currentLeaseId: string | null;
  marketRent: number | null;
}

export function delinquentUnitPayload(row: DelinquentUnitRow): DelinquentUnitPayload {
  return {
    unitId: row.resman_unit_id,
    unitNumber: row.number,
    tenantNames: row.tenant_names,
    balance: row.balance,
    currentMonthBalance: row.current_month_balance,
    lastMonthBalance: row.last_month_balance,
    periodBalance: row.period_balance,
    previousBalance: row.previous_balance,
    timesLate: row.times_late,
    delinquencyReason: row.delinquency_reason ?? "",
    leasingAgent: row.leasing_agent ?? "",
    currentLeaseId: row.current_lease_id,
    marketRent: row.market_rent,
  };
}

/**
 * Units where balance > 0 or delinquency_reason is set, by unit number. The
 * filter runs in JS over the slim column set: `or(balance.gt.0, …)` cannot
 * express "non-empty text" cleanly against a nullable column, and the whole
 * units table is small enough that one select is the simpler, testable path.
 */
export async function listDelinquentUnits(client: UntypedSupabase): Promise<DelinquentUnitPayload[]> {
  const { data, error } = await client
    .from("resman_units")
    .select(DELINQUENT_UNIT_COLUMNS)
    .order("number", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as DelinquentUnitRow[]).filter(isDelinquentUnit).map(delinquentUnitPayload);
}
