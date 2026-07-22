/**
 * Pure builder for the nightly property snapshot — one row per day in
 * public.property_snapshots, derived entirely from the already-synced mirror
 * tables (units with aging columns, work orders, MLGW accounts). No I/O here;
 * src/run-snapshots.ts reads the mirror and upserts the result.
 *
 * Column semantics (kept deliberately in lock-step with the app's own math so
 * a chart never disagrees with the board it sits next to):
 *
 *  - OCCUPANCY counts only real rentable units: `excluded_from_occupancy` and
 *    `holding_unit` rows are dropped, exactly like the manager app's
 *    `countsForOccupancy` (apps/manager/lib/derived/leasing.ts) and the PM
 *    generator's serviceable-unit filter.
 *  - AGING buckets mirror @emberly/core's `agingBucket` column mapping from
 *    the ResMan Delinquency-with-Aging report: current month = 0-30, last
 *    month = 31-60, period = 61-90, previous = 90+.
 *  - DELINQUENT units follow apps/web/lib/manager-delinquency.ts's
 *    `isDelinquentUnit`: positive balance OR a non-blank delinquency reason.
 *  - TURNS IN PROGRESS is a PROXY: the count of distinct unit numbers with at
 *    least one OPEN work order flagged `is_make_ready` (the sync's
 *    work-orders report sets that flag from the report's MakeReady bit plus a
 *    make-ready/turn category fold — see src/resman/reports/work-orders.ts).
 *    The full six-stage turn-board engine (@emberly/core make-ready) needs
 *    titles + unit facts; for a one-number daily series "a unit with an open
 *    make-ready ticket is mid-turn" is the honest cheap answer.
 */

// Work-order statuses that mean "no longer open" (matches the
// resman_work_orders CHECK constraint's terminal values).
const CLOSED_WORK_ORDER_STATUSES = new Set(["Completed", "Closed", "Canceled"]);

/** The resman_units columns the snapshot builder consumes. */
export interface SnapshotUnitRow {
  resman_unit_id: string;
  number: string | null;
  occupied: boolean | null;
  holding_unit: boolean | null;
  excluded_from_occupancy: boolean | null;
  market_rent: number | null;
  lease_rent: number | null;
  balance: number | null;
  current_month_balance: number | null;
  last_month_balance: number | null;
  period_balance: number | null;
  previous_balance: number | null;
  delinquency_reason: string | null;
}

/** The resman_work_orders columns the snapshot builder consumes. */
export interface SnapshotWorkOrderRow {
  unit_number: string | null;
  status: string | null;
  is_make_ready: boolean | null;
}

/** The mlgw_accounts columns the snapshot builder consumes. */
export interface SnapshotUtilityAccountRow {
  due_now: number | null;
}

/** The property_snapshots row shape the builder emits (snake_case, DB-ready). */
export interface PropertySnapshotRow {
  snapshot_date: string;
  total_units: number;
  occupied_units: number;
  vacant_units: number;
  occupancy_pct: number | null;
  rent_roll: number;
  lease_rent_total: number;
  balance_total: number;
  balance_0_30: number;
  balance_31_60: number;
  balance_61_90: number;
  balance_90_plus: number;
  delinquent_units: number;
  turns_in_progress: number;
  open_work_orders: number;
  utility_due: number;
  source: "nightly";
}

/** Round to cents/2dp — numeric(14,2) / numeric(5,2) columns. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Treat null/undefined as 0 for summation. */
function num(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Same membership rule as the app's `countsForOccupancy`. */
export function countsForOccupancy(
  unit: Pick<SnapshotUnitRow, "excluded_from_occupancy" | "holding_unit">,
): boolean {
  return unit.excluded_from_occupancy !== true && unit.holding_unit !== true;
}

/** Same membership rule as apps/web/lib/manager-delinquency.ts. */
export function isDelinquentUnit(
  unit: Pick<SnapshotUnitRow, "balance" | "delinquency_reason">,
): boolean {
  return num(unit.balance) > 0 || (unit.delinquency_reason ?? "").trim().length > 0;
}

/** An order still on somebody's plate: any non-terminal status. */
export function isOpenWorkOrder(order: Pick<SnapshotWorkOrderRow, "status">): boolean {
  return !CLOSED_WORK_ORDER_STATUSES.has((order.status ?? "").trim());
}

/**
 * "YYYY-MM-DD" for `now` in the property's time zone. The worker may run
 * anywhere (UTC container, laptop); the snapshot date must be the PROPERTY's
 * calendar day or a post-midnight-UTC run would stamp tomorrow's row.
 */
export function propertySnapshotDate(now: Date, timeZone = "America/Chicago"): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Fold the mirror into one snapshot row for `snapshotDate`.
 *
 *  - rent_roll         Σ market_rent over counted units (gross scheduled rent).
 *  - lease_rent_total  Σ lease_rent over counted OCCUPIED units (in-place
 *                      rent) — the two together are what a loss-to-lease
 *                      series divides.
 *  - balance_total     Σ balance over delinquent-by-balance units (positive
 *                      balances only; credits don't offset the owed series).
 *  - balance buckets   Σ of each aging column (clamped at ≥ 0) over units
 *                      with a positive balance.
 *  - utility_due       Σ mlgw_accounts.due_now.
 */
export function buildPropertySnapshot(input: {
  units: SnapshotUnitRow[];
  workOrders: SnapshotWorkOrderRow[];
  utilityAccounts: SnapshotUtilityAccountRow[];
  snapshotDate: string;
}): PropertySnapshotRow {
  const counted = input.units.filter(countsForOccupancy);
  const occupied = counted.filter((u) => u.occupied === true).length;
  const total = counted.length;

  let rentRoll = 0;
  let leaseRentTotal = 0;
  for (const unit of counted) {
    rentRoll += num(unit.market_rent);
    if (unit.occupied === true) leaseRentTotal += num(unit.lease_rent);
  }

  let balanceTotal = 0;
  let b0030 = 0;
  let b3160 = 0;
  let b6190 = 0;
  let b90 = 0;
  let delinquentUnits = 0;
  for (const unit of input.units) {
    if (isDelinquentUnit(unit)) delinquentUnits += 1;
    const balance = num(unit.balance);
    if (balance <= 0) continue;
    balanceTotal += balance;
    b0030 += Math.max(0, num(unit.current_month_balance));
    b3160 += Math.max(0, num(unit.last_month_balance));
    b6190 += Math.max(0, num(unit.period_balance));
    b90 += Math.max(0, num(unit.previous_balance));
  }

  const openOrders = input.workOrders.filter(isOpenWorkOrder);
  const turnUnits = new Set<string>();
  for (const order of openOrders) {
    if (order.is_make_ready !== true) continue;
    const unitNumber = (order.unit_number ?? "").trim();
    turnUnits.add(unitNumber.length > 0 ? unitNumber : "Unassigned Unit");
  }

  let utilityDue = 0;
  for (const account of input.utilityAccounts) utilityDue += num(account.due_now);

  return {
    snapshot_date: input.snapshotDate,
    total_units: total,
    occupied_units: occupied,
    vacant_units: total - occupied,
    occupancy_pct: total > 0 ? round2((occupied / total) * 100) : null,
    rent_roll: round2(rentRoll),
    lease_rent_total: round2(leaseRentTotal),
    balance_total: round2(balanceTotal),
    balance_0_30: round2(b0030),
    balance_31_60: round2(b3160),
    balance_61_90: round2(b6190),
    balance_90_plus: round2(b90),
    delinquent_units: delinquentUnits,
    turns_in_progress: turnUnits.size,
    open_work_orders: openOrders.length,
    utility_due: round2(utilityDue),
    source: "nightly",
  };
}
