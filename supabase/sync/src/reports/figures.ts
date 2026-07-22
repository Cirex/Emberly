/**
 * Pure builder for the monthly owner report's FROZEN figures.
 *
 * (mirror rows + snapshot rows + period) → one ReportFigures object covering
 * the approved mockup's Letter page: 4 KPI boxes, leasing/turns tables on the
 * left, aging/maintenance on the right, and the trailing-12-month occupancy
 * series. The figures object IS the report's payload of record — it is stored
 * as `<YYYY-MM>.json` next to the PDF ("report numbers freeze"): July's report
 * still says what it said even after late payments land in August.
 *
 * No I/O here; src/run-owner-report.ts reads the mirror and feeds this.
 *
 * Sourcing rules (kept in lock-step with the app's own math):
 *
 *  - CURRENT-STATE figures (occupancy counts, delinquency total, aging
 *    buckets, turns in progress) fold the mirror through the SAME
 *    `buildPropertySnapshot` the nightly snapshot job uses — the report is
 *    generated on the 1st, so "the mirror as synced" ≈ month end, and a chart
 *    in the app never disagrees with the packet.
 *  - MoM DELTAS compare the month-end snapshot row of the reporting month
 *    against the prior month's — the honest-backfill rule applies: fewer than
 *    two months of snapshots (or a null metric) means the delta is OMITTED
 *    (null), never faked. Utility MoM is the exception: it compares the two
 *    months' MLGW bills directly (bills carry their own period).
 *  - PERIOD-FLOW figures (collections, move-ins/outs, closed work orders,
 *    bills, PM tasks, delinquency actions) filter mirror rows by date into
 *    the reporting month's [start, end] window.
 *
 * RENEWALS: the renewal_offers table ships on a separate branch and may not
 * exist yet. The runner queries it in a try/catch and passes `null` here; the
 * template omits the row when the block is null.
 */

import {
  buildPropertySnapshot,
  countsForOccupancy,
  type SnapshotUnitRow,
} from "../snapshots/build";

// ── Period math ─────────────────────────────────────────────────────────────

/** Strict "YYYY-MM" with a real month. */
export function isValidReportPeriod(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export interface ReportPeriod {
  /** "YYYY-MM". */
  period: string;
  /** English display label, e.g. "July 2026". */
  label: string;
  /** First day of the month, "YYYY-MM-DD". */
  startDate: string;
  /** LAST day of the month (inclusive), "YYYY-MM-DD". */
  endDate: string;
  /** First day of the following month (exclusive bound for timestamps). */
  nextStartDate: string;
  /** The prior calendar month, "YYYY-MM". */
  priorPeriod: string;
  priorStartDate: string;
  priorEndDate: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function monthKey(year: number, month: number): string {
  return `${year}-${pad2(month)}`;
}

/** Days in `period`'s month (leap-safe). */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function priorMonthOf(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/** Expand "YYYY-MM" into the report's date window. Throws on junk. */
export function reportPeriodOf(period: string): ReportPeriod {
  if (!isValidReportPeriod(period)) {
    throw new Error(`Invalid report period "${period}" — expected YYYY-MM`);
  }
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const prior = priorMonthOf(year, month);
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return {
    period,
    label,
    startDate: `${period}-01`,
    endDate: `${period}-${pad2(lastDayOfMonth(year, month))}`,
    nextStartDate: `${monthKey(next.year, next.month)}-01`,
    priorPeriod: monthKey(prior.year, prior.month),
    priorStartDate: `${monthKey(prior.year, prior.month)}-01`,
    priorEndDate: `${monthKey(prior.year, prior.month)}-${pad2(lastDayOfMonth(prior.year, prior.month))}`,
  };
}

/**
 * "YYYY-MM" of the month BEFORE `now` in the property's time zone — the
 * default reporting period for a run on the 1st (America/Chicago, matching
 * the snapshot job's calendar).
 */
export function previousCalendarMonth(now: Date, timeZone = "America/Chicago"): string {
  // en-CA formats as YYYY-MM-DD; take the year-month.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const prior = priorMonthOf(year, month);
  return monthKey(prior.year, prior.month);
}

/** The `count` month keys ENDING AT `period`, chronological (oldest first). */
export function trailingMonths(period: string, count: number): string[] {
  if (!isValidReportPeriod(period)) {
    throw new Error(`Invalid report period "${period}" — expected YYYY-MM`);
  }
  let year = Number(period.slice(0, 4));
  let month = Number(period.slice(5, 7));
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.unshift(monthKey(year, month));
    ({ year, month } = priorMonthOf(year, month));
  }
  return out;
}

// ── Input row shapes (mirror columns the builder consumes) ──────────────────

export type ReportUnitRow = SnapshotUnitRow;

export interface ReportLeaseRow {
  unit_number: string | null;
  application_date: string | null;
  signed_date: string | null;
  move_in_date: string | null;
  move_out_date: string | null;
  resident_rent: number | null;
  is_current_lease: boolean | null;
}

export interface ReportTransactionRow {
  date: string | null;
  charges: number | null;
  credits: number | null;
}

export interface ReportWorkOrderRow {
  resman_work_order_id: string;
  unit_number: string | null;
  status: string | null;
  priority: string | null;
  is_make_ready: boolean | null;
  date_reported: string | null;
  date_completed: string | null;
  callback_status: string | null;
}

export interface ReportBillRow {
  bill_date: string | null;
  amount_due: number | null;
  balance_forward: number | null;
  gas_total: number | null;
  electric_total: number | null;
  water_total: number | null;
  sewer_total: number | null;
  other_mlgw_total: number | null;
}

export interface ReportPmTaskRow {
  round_key: string;
  status: string | null;
  due_date: string | null;
  completed_at: string | null;
}

export interface ReportDelinquencyActionRow {
  kind: string | null;
  created_at: string | null;
}

export interface ReportSnapshotDayRow {
  snapshot_date: string;
  occupancy_pct: number | null;
  balance_total: number | null;
  total_units: number | null;
}

/** Defensively pre-mapped renewal_offers row (see run-owner-report.ts). */
export interface ReportRenewalOfferRow {
  outcome: string | null;
  sent_at: string | null;
  responded_at: string | null;
}

// ── Output shape (the frozen JSON payload) ──────────────────────────────────

export interface ReportAgingBucket {
  bucket: "0-30" | "31-60" | "61-90" | "90+";
  units: number;
  balance: number;
}

export interface ReportFigures {
  version: 1;
  period: string;
  periodLabel: string;
  /** ISO timestamp of generation — the freeze moment. */
  generatedAt: string;
  property: { name: string; totalUnits: number | null };
  occupancy: {
    pct: number | null;
    occupiedUnits: number | null;
    vacantUnits: number | null;
    totalUnits: number | null;
    /** Month-end vs prior month-end, in points. Null until 2 months of snapshots exist. */
    momDeltaPts: number | null;
  };
  collections: {
    /** Σ charges over the period's ledger rows. Null when no rows synced for the period. */
    billed: number | null;
    /** Σ credits over the period's ledger rows. */
    collected: number | null;
    ratePct: number | null;
  };
  delinquency: {
    total: number | null;
    /** Month-end snapshot vs prior month-end snapshot. Null-safe. */
    momDelta: number | null;
    aging: ReportAgingBucket[] | null;
    /** Collection touchpoints logged in the manager app this period. Null when none. */
    actions: { notices: number; promises: number; fedFilings: number } | null;
  };
  utilities: {
    /** New MLGW charges billed in the period (component totals; balance-forward excluded). */
    spend: number | null;
    momDeltaPct: number | null;
  };
  leasing: {
    moveIns: number;
    moveOuts: number;
    applications: number;
    avgSignedRent: number | null;
    /** Σ (market − in-place) over occupied units, annualized. Null when underivable. */
    lossToLeasePerYear: number | null;
    /** Null when the renewal_offers table doesn't exist yet (separate branch). */
    renewals: { accepted: number; offersOut: number } | null;
  };
  turns: {
    completed: number;
    inProgress: number;
    /** PROXY: in-progress turn units whose pending lease's move-in date has passed. */
    lateForMoveIn: number;
    avgDaysInTurn: number | null;
    /** Σ turn-days × daily market rent over completed turns. Null when underivable. */
    vacancyCost: number | null;
  };
  maintenance: {
    closed: number;
    emergencies: number;
    callbackRatePct: number | null;
    preventive: { completed: number; total: number; onTime: number } | null;
  };
  /** Trailing 12 months ending at the period; null = series hadn't begun. */
  occupancySeries: Array<{ month: string; occupancyPct: number | null }>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function num(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** "YYYY-MM-DD" from a date or timestamp string; null on junk. */
function dayOf(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length < 10) return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** Whole calendar days from `a` to `b` ("YYYY-MM-DD" each). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function inWindow(day: string | null, start: string, end: string): boolean {
  return day !== null && day >= start && day <= end;
}

const OPEN_STATUSES_EXCLUDED = new Set(["Completed", "Closed", "Canceled"]);
function isOpenStatus(status: string | null): boolean {
  return !OPEN_STATUSES_EXCLUDED.has((status ?? "").trim());
}

/** Latest snapshot row dated INSIDE the given month, or null. A stale row from
 *  an older month never stands in for a month end. */
function monthEndSnapshot(
  snapshots: ReportSnapshotDayRow[],
  monthStart: string,
  monthEnd: string,
): ReportSnapshotDayRow | null {
  let best: ReportSnapshotDayRow | null = null;
  for (const row of snapshots) {
    if (row.snapshot_date < monthStart || row.snapshot_date > monthEnd) continue;
    if (best === null || row.snapshot_date > best.snapshot_date) best = row;
  }
  return best;
}

// ── The builder ─────────────────────────────────────────────────────────────

export function buildReportFigures(input: {
  period: ReportPeriod;
  /** ISO timestamp; recorded verbatim and used for the late-move-in cutoff. */
  generatedAt: string;
  propertyName: string;
  units: ReportUnitRow[];
  leases: ReportLeaseRow[];
  /** Ledger rows for the reporting month (the runner windows the read). */
  transactions: ReportTransactionRow[];
  /** Open work orders + those completed in the period (deduped by the runner). */
  workOrders: ReportWorkOrderRow[];
  /** Bills for the reporting month AND the prior month (utility MoM). */
  bills: ReportBillRow[];
  pmTasks: ReportPmTaskRow[];
  delinquencyActions: ReportDelinquencyActionRow[];
  snapshots: ReportSnapshotDayRow[];
  renewalOffers: ReportRenewalOfferRow[] | null;
}): ReportFigures {
  const p = input.period;
  const generatedDay = dayOf(input.generatedAt) ?? p.endDate;

  // Current-state fold — the same math as the nightly snapshot job.
  const fold = buildPropertySnapshot({
    units: input.units,
    workOrders: input.workOrders.map((w) => ({
      unit_number: w.unit_number,
      status: w.status,
      is_make_ready: w.is_make_ready,
    })),
    utilityAccounts: [],
    snapshotDate: p.endDate,
  });
  const haveUnits = input.units.length > 0;

  const monthEnd = monthEndSnapshot(input.snapshots, p.startDate, p.endDate);
  const priorEnd = monthEndSnapshot(input.snapshots, p.priorStartDate, p.priorEndDate);

  // ── Occupancy ─────────────────────────────────────────────────────────────
  const occupancyPct = monthEnd?.occupancy_pct ?? (haveUnits ? fold.occupancy_pct : null);
  const momDeltaPts =
    monthEnd?.occupancy_pct != null && priorEnd?.occupancy_pct != null
      ? round2(monthEnd.occupancy_pct - priorEnd.occupancy_pct)
      : null;

  // ── Collections ───────────────────────────────────────────────────────────
  let billed = 0;
  let collected = 0;
  let sawTransaction = false;
  for (const txn of input.transactions) {
    if (!inWindow(dayOf(txn.date), p.startDate, p.endDate)) continue;
    sawTransaction = true;
    billed += num(txn.charges);
    collected += num(txn.credits);
  }
  const collections = sawTransaction
    ? {
        billed: round2(billed),
        collected: round2(collected),
        ratePct: billed > 0 ? round2((collected / billed) * 100) : null,
      }
    : { billed: null, collected: null, ratePct: null };

  // ── Delinquency ───────────────────────────────────────────────────────────
  const aging: ReportAgingBucket[] | null = haveUnits
    ? [
        { bucket: "0-30", key: "current_month_balance" as const },
        { bucket: "31-60", key: "last_month_balance" as const },
        { bucket: "61-90", key: "period_balance" as const },
        { bucket: "90+", key: "previous_balance" as const },
      ].map(({ bucket, key }) => {
        let unitCount = 0;
        let balance = 0;
        for (const unit of input.units) {
          if (num(unit.balance) <= 0) continue;
          const slice = Math.max(0, num(unit[key]));
          if (slice <= 0) continue;
          unitCount += 1;
          balance += slice;
        }
        return { bucket: bucket as ReportAgingBucket["bucket"], units: unitCount, balance: round2(balance) };
      })
    : null;

  let notices = 0;
  let promises = 0;
  let fedFilings = 0;
  for (const action of input.delinquencyActions) {
    if (!inWindow(dayOf(action.created_at), p.startDate, p.endDate)) continue;
    if (action.kind === "notice_served") notices += 1;
    else if (action.kind === "promise_recorded") promises += 1;
    else if (action.kind === "fed_filed") fedFilings += 1;
  }
  const actions =
    notices + promises + fedFilings > 0 ? { notices, promises, fedFilings } : null;

  const delinquency = {
    total: haveUnits ? fold.balance_total : (monthEnd?.balance_total ?? null),
    momDelta:
      monthEnd?.balance_total != null && priorEnd?.balance_total != null
        ? round2(monthEnd.balance_total - priorEnd.balance_total)
        : null,
    aging,
    actions,
  };

  // ── Utilities ─────────────────────────────────────────────────────────────
  const newCharges = (bill: ReportBillRow): number | null => {
    const components = [
      bill.gas_total,
      bill.electric_total,
      bill.water_total,
      bill.sewer_total,
      bill.other_mlgw_total,
    ].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (components.length > 0) return components.reduce((sum, v) => sum + v, 0);
    if (typeof bill.amount_due === "number" && Number.isFinite(bill.amount_due)) {
      return bill.amount_due - num(bill.balance_forward);
    }
    return null;
  };
  const monthSpend = (start: string, end: string): number | null => {
    let total = 0;
    let saw = false;
    for (const bill of input.bills) {
      if (!inWindow(dayOf(bill.bill_date), start, end)) continue;
      const charge = newCharges(bill);
      if (charge === null) continue;
      saw = true;
      total += charge;
    }
    return saw ? round2(total) : null;
  };
  const spend = monthSpend(p.startDate, p.endDate);
  const priorSpend = monthSpend(p.priorStartDate, p.priorEndDate);
  const utilities = {
    spend,
    momDeltaPct:
      spend !== null && priorSpend !== null && priorSpend > 0
        ? round1(((spend - priorSpend) / priorSpend) * 100)
        : null,
  };

  // ── Leasing ───────────────────────────────────────────────────────────────
  let moveIns = 0;
  let moveOuts = 0;
  let applications = 0;
  let signedRentSum = 0;
  let signedRentCount = 0;
  for (const lease of input.leases) {
    if (inWindow(dayOf(lease.move_in_date), p.startDate, p.endDate)) moveIns += 1;
    if (inWindow(dayOf(lease.move_out_date), p.startDate, p.endDate)) moveOuts += 1;
    if (inWindow(dayOf(lease.application_date), p.startDate, p.endDate)) applications += 1;
    if (
      inWindow(dayOf(lease.signed_date), p.startDate, p.endDate) &&
      typeof lease.resident_rent === "number" &&
      Number.isFinite(lease.resident_rent)
    ) {
      signedRentSum += lease.resident_rent;
      signedRentCount += 1;
    }
  }

  let lossToLease = 0;
  let lossContributors = 0;
  for (const unit of input.units) {
    if (!countsForOccupancy(unit) || unit.occupied !== true) continue;
    if (typeof unit.market_rent !== "number" || typeof unit.lease_rent !== "number") continue;
    if (!Number.isFinite(unit.market_rent) || !Number.isFinite(unit.lease_rent)) continue;
    lossToLease += unit.market_rent - unit.lease_rent;
    lossContributors += 1;
  }

  let renewals: { accepted: number; offersOut: number } | null = null;
  if (input.renewalOffers !== null) {
    let accepted = 0;
    let offersOut = 0;
    for (const offer of input.renewalOffers) {
      const outcome = (offer.outcome ?? "").trim().toLowerCase();
      if (outcome === "accepted" && inWindow(dayOf(offer.responded_at), p.startDate, p.endDate)) {
        accepted += 1;
      }
      if (offer.sent_at !== null && (outcome === "" || outcome === "pending" || outcome === "sent")) {
        offersOut += 1;
      }
    }
    renewals = { accepted, offersOut };
  }

  const leasing = {
    moveIns,
    moveOuts,
    applications,
    avgSignedRent: signedRentCount > 0 ? round2(signedRentSum / signedRentCount) : null,
    lossToLeasePerYear: lossContributors > 0 ? round2(lossToLease * 12) : null,
    renewals,
  };

  // ── Turns (make-ready orders grouped per unit — same proxy as snapshots) ──
  interface TurnUnit {
    open: boolean;
    completedInPeriod: boolean;
    earliestReported: string | null;
    latestCompleted: string | null;
  }
  const turnUnits = new Map<string, TurnUnit>();
  for (const order of input.workOrders) {
    if (order.is_make_ready !== true) continue;
    const key = (order.unit_number ?? "").trim() || "Unassigned Unit";
    const entry = turnUnits.get(key) ?? {
      open: false,
      completedInPeriod: false,
      earliestReported: null,
      latestCompleted: null,
    };
    if (isOpenStatus(order.status)) entry.open = true;
    const reported = dayOf(order.date_reported);
    if (reported !== null && (entry.earliestReported === null || reported < entry.earliestReported)) {
      entry.earliestReported = reported;
    }
    const completed = dayOf(order.date_completed);
    if (inWindow(completed, p.startDate, p.endDate)) {
      entry.completedInPeriod = true;
      if (entry.latestCompleted === null || (completed !== null && completed > entry.latestCompleted)) {
        entry.latestCompleted = completed;
      }
    }
    turnUnits.set(key, entry);
  }

  const marketByUnit = new Map<string, number>();
  for (const unit of input.units) {
    const key = (unit.number ?? "").trim();
    if (key.length > 0 && typeof unit.market_rent === "number" && Number.isFinite(unit.market_rent)) {
      marketByUnit.set(key, unit.market_rent);
    }
  }

  let turnsCompleted = 0;
  let turnsInProgress = 0;
  let turnDaysSum = 0;
  let turnDaysCount = 0;
  let vacancyCost = 0;
  let vacancyContributors = 0;
  const inProgressUnits: string[] = [];
  for (const [unitNumber, entry] of turnUnits) {
    if (entry.open) {
      turnsInProgress += 1;
      inProgressUnits.push(unitNumber);
      continue;
    }
    if (!entry.completedInPeriod) continue;
    turnsCompleted += 1;
    if (entry.earliestReported !== null && entry.latestCompleted !== null) {
      const days = Math.max(1, daysBetween(entry.earliestReported, entry.latestCompleted));
      turnDaysSum += days;
      turnDaysCount += 1;
      const market = marketByUnit.get(unitNumber);
      if (market !== undefined) {
        vacancyCost += days * ((market * 12) / 365);
        vacancyContributors += 1;
      }
    }
  }

  // Late for move-in (proxy): an in-progress turn unit with a PENDING lease
  // (not current, no move-out) whose move-in date fell inside the reporting
  // window or since — i.e. the move-in day passed while the unit was mid-turn.
  const pendingMoveInByUnit = new Map<string, boolean>();
  for (const lease of input.leases) {
    const unitKey = (lease.unit_number ?? "").trim();
    if (unitKey.length === 0 || lease.is_current_lease === true) continue;
    const moveIn = dayOf(lease.move_in_date);
    if (moveIn === null || lease.move_out_date !== null) continue;
    if (moveIn >= p.startDate && moveIn <= generatedDay) pendingMoveInByUnit.set(unitKey, true);
  }
  const lateForMoveIn = inProgressUnits.filter((unit) => pendingMoveInByUnit.has(unit)).length;

  const turns = {
    completed: turnsCompleted,
    inProgress: turnsInProgress,
    lateForMoveIn,
    avgDaysInTurn: turnDaysCount > 0 ? round1(turnDaysSum / turnDaysCount) : null,
    vacancyCost: vacancyContributors > 0 ? round2(vacancyCost) : null,
  };

  // ── Maintenance (non-make-ready orders) ───────────────────────────────────
  let closed = 0;
  let emergencies = 0;
  let reportedInPeriod = 0;
  let callbacks = 0;
  for (const order of input.workOrders) {
    if (order.is_make_ready === true) continue;
    const status = (order.status ?? "").trim();
    if (
      (status === "Completed" || status === "Closed") &&
      inWindow(dayOf(order.date_completed), p.startDate, p.endDate)
    ) {
      closed += 1;
    }
    if (inWindow(dayOf(order.date_reported), p.startDate, p.endDate)) {
      reportedInPeriod += 1;
      if ((order.priority ?? "").trim() === "Emergency") emergencies += 1;
      const cb = (order.callback_status ?? "").trim();
      if (cb === "possible" || cb === "confirmed") callbacks += 1;
    }
  }

  let pmTotal = 0;
  let pmCompleted = 0;
  let pmOnTime = 0;
  for (const task of input.pmTasks) {
    if (task.round_key !== p.period) continue;
    pmTotal += 1;
    if (task.status !== "done") continue;
    pmCompleted += 1;
    const completedDay = dayOf(task.completed_at);
    const due = dayOf(task.due_date);
    if (completedDay !== null && due !== null && completedDay <= due) pmOnTime += 1;
  }

  const maintenance = {
    closed,
    emergencies,
    callbackRatePct: reportedInPeriod > 0 ? round1((callbacks / reportedInPeriod) * 100) : null,
    preventive: pmTotal > 0 ? { completed: pmCompleted, total: pmTotal, onTime: pmOnTime } : null,
  };

  // ── Occupancy series (trailing 12 months) ─────────────────────────────────
  const occupancySeries = trailingMonths(p.period, 12).map((month) => {
    const end = `${month}-${pad2(lastDayOfMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7))))}`;
    const snap = monthEndSnapshot(input.snapshots, `${month}-01`, end);
    return { month, occupancyPct: snap?.occupancy_pct ?? null };
  });

  return {
    version: 1,
    period: p.period,
    periodLabel: p.label,
    generatedAt: input.generatedAt,
    property: {
      name: input.propertyName,
      totalUnits: haveUnits ? fold.total_units : (monthEnd?.total_units ?? null),
    },
    occupancy: {
      pct: occupancyPct,
      occupiedUnits: haveUnits ? fold.occupied_units : null,
      vacantUnits: haveUnits ? fold.vacant_units : null,
      totalUnits: haveUnits ? fold.total_units : (monthEnd?.total_units ?? null),
      momDeltaPts,
    },
    collections,
    delinquency,
    utilities,
    leasing,
    turns,
    maintenance,
    occupancySeries,
  };
}
