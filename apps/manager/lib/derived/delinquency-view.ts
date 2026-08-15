import {
  AGING_BUCKETS,
  agingBucket,
  buildAgentStats,
  daysSinceMoveIn,
  TENURE_BUCKETS,
  tenureBucket,
  delinquencyPriority,
  isRenewalLease,
  netPosition,
  verdictFor,
  type AgentLeaseInput,
  type AgentStat,
  type AgingBucket,
  type LeaseVerdict,
  type TenureBucket,
} from "@emberly/core";
import type {
  DelinquencyAction,
  DelinquentUnit,
  LeaseLedgerSummary,
  LedgerEntry,
  ManagerLease,
} from "@/lib/api/delinquency";

/**
 * Pure view-model derivations for the Delinquency (Money) board. Everything
 * here is a function of synced data + `nowMs` — no I/O, no store imports, no
 * React — so the whole board's logic is unit-testable (tests/delinquency-view.test.ts).
 */

const n = (v: number | null | undefined): number => (typeof v === "number" ? v : 0);

/** /evict/i over free text — the sync writes phrases like "Eviction filed". */
const EVICT_RE = /evict/i;

// ---- aging distribution (the meter bar) ------------------------------------

export interface AgingSegment {
  bucket: AgingBucket;
  /** Dollars sitting in this bucket (negative columns clamp to 0). */
  amount: number;
  /** Share of the total owed, 0..1 (0 when nothing is owed). */
  percent: number;
}

/**
 * Sum each unit's aging columns into the four buckets for the meter bar:
 * currentMonth → 0-30, lastMonth → 31-60, period → 61-90, previous → 90+.
 * Credit (negative) columns are clamped to 0 — the meter shows where debt
 * sits, not net accounting.
 */
export function agingDistribution(units: readonly DelinquentUnit[]): {
  total: number;
  segments: AgingSegment[];
} {
  const sums: Record<AgingBucket, number> = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  for (const unit of units) {
    sums["0-30"] += Math.max(0, n(unit.currentMonthBalance));
    sums["31-60"] += Math.max(0, n(unit.lastMonthBalance));
    sums["61-90"] += Math.max(0, n(unit.periodBalance));
    sums["90+"] += Math.max(0, n(unit.previousBalance));
  }
  const total = AGING_BUCKETS.reduce((acc, b) => acc + sums[b], 0);
  return {
    total,
    segments: AGING_BUCKETS.map((bucket) => ({
      bucket,
      amount: sums[bucket],
      percent: total > 0 ? sums[bucket] / total : 0,
    })),
  };
}

// ---- promise status --------------------------------------------------------

export type PromiseState = "open" | "kept" | "broken";

export interface PromiseStatus {
  state: PromiseState;
  /** "YYYY-MM-DD" the promise/plan payment is due. */
  dueDate: string;
  amount: number | null;
  /** createdAt of the promise_recorded / payment_plan action. */
  recordedAt: string;
}

const dateOnly = (iso: string): string => iso.slice(0, 10);

/**
 * Derive each lease's promise status from its LATEST dated
 * promise_recorded/payment_plan action:
 *  - kept:   a promise_kept action recorded at/after the promise, OR (once the
 *            due date passed) a ledger payment dated on/after the promise was
 *            recorded — money arriving after the promise counts as keeping it.
 *  - open:   due date is today or later and not yet kept.
 *  - broken: due date passed with no promise_kept and no payment since.
 * Leases with no dated promise are absent from the map.
 */
export function promiseStatusByLease(
  actions: readonly DelinquencyAction[],
  lastPaymentByLease: ReadonlyMap<string, string>,
  nowMs: number,
): Map<string, PromiseStatus> {
  const today = dateOnly(new Date(nowMs).toISOString());
  const out = new Map<string, PromiseStatus>();

  // Latest dated promise per lease (actions arrive newest first, but sort defensively).
  const promises = new Map<string, DelinquencyAction>();
  for (const action of actions) {
    if (action.kind !== "promise_recorded" && action.kind !== "payment_plan") continue;
    if (!action.promiseDueDate || !action.createdAt) continue;
    const prev = promises.get(action.resmanLeaseId);
    if (!prev || (prev.createdAt ?? "") < action.createdAt) promises.set(action.resmanLeaseId, action);
  }

  for (const [leaseId, promise] of promises) {
    const recordedAt = promise.createdAt ?? "";
    const keptAction = actions.some(
      (a) => a.resmanLeaseId === leaseId && a.kind === "promise_kept" && (a.createdAt ?? "") >= recordedAt,
    );
    const duePast = promise.promiseDueDate! < today;
    const lastPayment = lastPaymentByLease.get(leaseId);
    const paidSince = lastPayment !== undefined && lastPayment >= dateOnly(recordedAt);

    let state: PromiseState;
    if (keptAction || (duePast && paidSince)) state = "kept";
    else if (!duePast) state = "open";
    else state = "broken";

    out.set(leaseId, {
      state,
      dueDate: promise.promiseDueDate!,
      amount: promise.amount ?? null,
      recordedAt,
    });
  }
  return out;
}

// ---- next-action suggestion ------------------------------------------------

/**
 * NEXT-ACTION DECISION TABLE — evaluated top-down, first match wins:
 *
 * | # | Condition                                                | Suggestion  |
 * |---|----------------------------------------------------------|-------------|
 * | 1 | evicted (reason/eviction_completed), owes, no writeoff   | writeOff    |
 * | 2 | fed_filed logged (eviction not yet completed)            | awaitCourt  |
 * | 3 | promise broken (dated promise past due, nothing since)   | escalate    |
 * | 4 | 90+ bucket AND notice_served logged                      | fileFed     |
 * | 5 | 90+ bucket, no notice yet                                | serveNotice |
 * | 6 | open promise (due today or later)                        | onTrack     |
 * | 7 | 31-60 / 61-90 bucket AND no action ever logged           | serveNotice |
 * | 8 | 31-60 / 61-90 bucket with prior action                   | call        |
 * | 9 | 0-30 bucket                                              | watch       |
 * |10 | no bucket (reason-only row, nothing owed)                | review      |
 */
export type NextAction =
  | "writeOff"
  | "awaitCourt"
  | "escalate"
  | "fileFed"
  | "serveNotice"
  | "onTrack"
  | "call"
  | "watch"
  | "review";

export interface NextActionContext {
  bucket: AgingBucket | null;
  evicted: boolean;
  hasFedFiled: boolean;
  hasEvictionCompleted: boolean;
  hasNoticeServed: boolean;
  hasWriteoff: boolean;
  hasAnyAction: boolean;
  promiseState: PromiseState | null;
  balance: number;
}

export function suggestNextAction(ctx: NextActionContext): NextAction {
  if (ctx.evicted && ctx.balance > 0 && !ctx.hasWriteoff) return "writeOff";
  if (ctx.hasFedFiled && !ctx.hasEvictionCompleted) return "awaitCourt";
  if (ctx.promiseState === "broken") return "escalate";
  if (ctx.bucket === "90+") return ctx.hasNoticeServed ? "fileFed" : "serveNotice";
  if (ctx.promiseState === "open") return "onTrack";
  if (ctx.bucket === "31-60" || ctx.bucket === "61-90") {
    return ctx.hasAnyAction ? "call" : "serveNotice";
  }
  if (ctx.bucket === "0-30") return "watch";
  return "review";
}

// ---- the banded, prioritized balances queue --------------------------------

export type QueueBand = "needsAction" | "promise" | "currentCycle";

export interface QueueRow {
  unit: DelinquentUnit;
  bucket: AgingBucket | null;
  balance: number;
  priority: number;
  suggestion: NextAction;
  band: QueueBand;
  evicted: boolean;
  promise: PromiseStatus | null;
  /** Newest action logged against the unit's current lease, if any. */
  lastAction: DelinquencyAction | null;
  /** True when no action has ever been logged for the lease. */
  noActionEver: boolean;
  /** Days the resident has lived here, or null when no move-in date is known. */
  tenureDays: number | null;
  /** {@link tenureDays} banded; null when the move-in date is unknown. */
  tenure: TenureBucket | null;
}

export interface BalancesBoard {
  rows: QueueRow[];
  bands: Record<QueueBand, QueueRow[]>;
  /**
   * The same rows grouped by how long the resident has lived here, newest
   * tenancy first, plus an `unknown` group for units with no move-in date so
   * nothing silently drops out of the grouped view.
   */
  tenureGroups: { bucket: TenureBucket | "unknown"; rows: QueueRow[]; owed: number }[];
  distribution: ReturnType<typeof agingDistribution>;
  totalOwed: number;
  evictionCount: number;
  fedFiledCount: number;
  promiseCount: number;
  ninetyPlusCount: number;
  noActionCount: number;
}

/**
 * Assemble the Balances mode: every delinquent unit classified into one band —
 *  - promise:      an un-kept dated promise exists (open or broken);
 *  - needsAction:  aged debt (31+ days) or an eviction in flight;
 *  - currentCycle: 0-30 day balances and reason-only rows.
 * Bands sort by delinquencyPriority (descending), with a broken promise
 * feeding the priority's +500 term.
 */
export function buildBalancesBoard(
  units: readonly DelinquentUnit[],
  actions: readonly DelinquencyAction[],
  lastPaymentByLease: ReadonlyMap<string, string>,
  nowMs: number,
  /**
   * unitId → the resident's move-in date. The delinquency report carries no
   * move-in date, so the caller joins it from the leases it already holds.
   * Units missing from the map group under `unknown`.
   */
  moveInByUnit: ReadonlyMap<string, string> = new Map(),
): BalancesBoard {
  const promiseStatuses = promiseStatusByLease(actions, lastPaymentByLease, nowMs);

  const actionsByLease = new Map<string, DelinquencyAction[]>();
  for (const action of actions) {
    const list = actionsByLease.get(action.resmanLeaseId);
    if (list) list.push(action);
    else actionsByLease.set(action.resmanLeaseId, [action]);
  }

  const rows: QueueRow[] = units.map((unit) => {
    const leaseId = unit.currentLeaseId ?? "";
    const leaseActions = actionsByLease.get(leaseId) ?? [];
    const has = (kind: DelinquencyAction["kind"]) => leaseActions.some((a) => a.kind === kind);
    const promise = promiseStatuses.get(leaseId) ?? null;
    const bucket = agingBucket(unit);
    const balance = Math.max(0, n(unit.balance));
    const evicted = EVICT_RE.test(unit.delinquencyReason) || has("eviction_completed");

    const suggestion = suggestNextAction({
      bucket,
      evicted,
      hasFedFiled: has("fed_filed"),
      hasEvictionCompleted: has("eviction_completed"),
      hasNoticeServed: has("notice_served"),
      hasWriteoff: has("writeoff"),
      hasAnyAction: leaseActions.length > 0,
      promiseState: promise?.state ?? null,
      balance,
    });

    const band: QueueBand =
      promise && promise.state !== "kept"
        ? "promise"
        : evicted || bucket === "31-60" || bucket === "61-90" || bucket === "90+"
          ? "needsAction"
          : "currentCycle";

    const lastAction =
      leaseActions.length > 0
        ? leaseActions.reduce((best, a) => ((a.createdAt ?? "") > (best.createdAt ?? "") ? a : best))
        : null;

    const tenureDays = daysSinceMoveIn(moveInByUnit.get(unit.unitId) ?? null, nowMs);

    return {
      unit,
      bucket,
      balance,
      priority: delinquencyPriority({
        balance,
        agingBucket: bucket,
        timesLate: n(unit.timesLate),
        brokenPromise: promise?.state === "broken",
      }),
      suggestion,
      band,
      evicted,
      promise,
      lastAction,
      noActionEver: leaseActions.length === 0,
      tenureDays,
      tenure: tenureDays === null ? null : tenureBucket(tenureDays),
    };
  });

  rows.sort((a, b) => b.priority - a.priority || a.unit.unitNumber.localeCompare(b.unit.unitNumber));

  const bands: Record<QueueBand, QueueRow[]> = { needsAction: [], promise: [], currentCycle: [] };
  for (const row of rows) bands[row.band].push(row);

  // Tenure groups keep the priority sort WITHIN each band, so the worst row in
  // a tenure group is still the first one you see. Empty bands are dropped —
  // a header over nothing is just noise — but `unknown` is kept whenever it
  // has rows, so a missing move-in date never silently hides a debtor.
  const byTenure = new Map<TenureBucket | "unknown", QueueRow[]>();
  for (const row of rows) {
    const key = row.tenure ?? "unknown";
    const list = byTenure.get(key);
    if (list) list.push(row);
    else byTenure.set(key, [row]);
  }
  const tenureGroups = [...TENURE_BUCKETS, "unknown" as const]
    .map((bucket) => {
      const groupRows = byTenure.get(bucket) ?? [];
      return { bucket, rows: groupRows, owed: groupRows.reduce((acc, r) => acc + r.balance, 0) };
    })
    .filter((g) => g.rows.length > 0);

  return {
    rows,
    bands,
    tenureGroups,
    distribution: agingDistribution(units),
    totalOwed: rows.reduce((acc, r) => acc + r.balance, 0),
    evictionCount: rows.filter((r) => r.evicted).length,
    fedFiledCount: rows.filter((r) => (actionsByLease.get(r.unit.currentLeaseId ?? "") ?? []).some((a) => a.kind === "fed_filed")).length,
    promiseCount: bands.promise.length,
    ninetyPlusCount: rows.filter((r) => r.bucket === "90+").length,
    noActionCount: rows.filter((r) => r.noActionEver).length,
  };
}

// ---- tenant P&L ------------------------------------------------------------

/** Action kinds whose `amount` counts as legal/collections spend. */
const LEGAL_KINDS = new Set<DelinquencyAction["kind"]>([
  "notice_served",
  "fed_filed",
  "eviction_completed",
]);

export interface TenantPnl {
  leaseId: string;
  unitId: string | null;
  unitNumber: string;
  tenantName: string;
  leasingAgent: string;
  isCurrentLease: boolean;
  evicted: boolean;
  moveInDate: string | null;
  monthsOccupied: number;
  billed: number;
  collected: number;
  /** Current unpaid balance, clamped to >= 0. */
  openBalance: number;
  /** Concessions given (cost, >= 0). */
  concessions: number;
  /** Write-offs + open balance — dollars billed that we will not / have not seen. */
  badDebt: number;
  /** Sum of legal-kind action amounts (notices, FED filings, evictions). */
  legal: number;
  /** Utility exposure — not yet synced per lease; always 0, labeled in UI. */
  utilityExposure: number;
  /** Maintenance estimate — WO cost feed not yet tracked; always 0, labeled in UI. */
  maintenanceEstimate: number;
  net: number;
  verdict: LeaseVerdict;
  /** collected / billed, 1 when nothing billed. */
  collectionRate: number;
  timesLate: number;
  promise: PromiseStatus | null;
  suggestion: NextAction | null;
}

/** Whole calendar months between two ISO dates, floored, min 0. */
function monthsBetween(fromIso: string, toMs: number): number {
  const m = /^(\d{4})-(\d{2})/.exec(fromIso);
  if (!m) return 0;
  const to = new Date(toMs);
  const months = to.getFullYear() * 12 + to.getMonth() - (Number(m[1]) * 12 + (Number(m[2]) - 1));
  return Math.max(0, months);
}

/**
 * TENANT P&L ASSEMBLY. One income statement per lease that has a ledger
 * summary. The stated formula (also in the UI footer):
 *
 *   net = collected − concessions − badDebt − legal − utilityExposure − maintenanceEstimate
 *
 * where badDebt = write-offs (ledger) + open balance (unpaid but not yet
 * written off — the two are mutually exclusive states of the same dollars, so
 * summing never double-counts), legal = amounts on notice/FED/eviction
 * actions, and utilityExposure / maintenanceEstimate are 0 until their feeds
 * exist (the UI labels those lines "not yet tracked"). Verdict via
 * verdictFor(net, monthsOccupied).
 */
export function assembleTenantPnl(args: {
  leases: readonly ManagerLease[];
  units: readonly DelinquentUnit[];
  summaries: readonly LeaseLedgerSummary[];
  actions: readonly DelinquencyAction[];
  nowMs: number;
}): TenantPnl[] {
  const { leases, units, summaries, actions, nowMs } = args;
  const summaryByLease = new Map(summaries.map((s) => [s.leaseId, s]));
  const unitById = new Map(units.map((u) => [u.unitId, u]));
  const lastPayment = lastPaymentMap(summaries);
  const promises = promiseStatusByLease(actions, lastPayment, nowMs);

  const legalByLease = new Map<string, number>();
  const evictionActionLeases = new Set<string>();
  const actionsByLease = new Map<string, DelinquencyAction[]>();
  for (const action of actions) {
    if (LEGAL_KINDS.has(action.kind) && typeof action.amount === "number" && action.amount > 0) {
      legalByLease.set(action.resmanLeaseId, (legalByLease.get(action.resmanLeaseId) ?? 0) + action.amount);
    }
    if (action.kind === "eviction_completed") evictionActionLeases.add(action.resmanLeaseId);
    const list = actionsByLease.get(action.resmanLeaseId);
    if (list) list.push(action);
    else actionsByLease.set(action.resmanLeaseId, [action]);
  }

  const out: TenantPnl[] = [];
  for (const lease of leases) {
    const summary = summaryByLease.get(lease.id);
    if (!summary) continue; // no ledger yet — no P&L to state

    const unit = lease.unitId ? unitById.get(lease.unitId) : undefined;
    const evicted =
      EVICT_RE.test(lease.status) ||
      evictionActionLeases.has(lease.id) ||
      (lease.isCurrentLease && unit !== undefined && EVICT_RE.test(unit.delinquencyReason));

    const openBalance = Math.max(
      0,
      typeof lease.balance === "number" ? lease.balance : lease.isCurrentLease ? n(unit?.balance) : 0,
    );
    const concessions = Math.max(0, summary.concessions);
    const badDebt = Math.max(0, summary.writeoffs) + openBalance;
    const legal = legalByLease.get(lease.id) ?? 0;

    const startIso = lease.moveInDate ?? lease.startDate ?? null;
    const endMs = lease.moveOutDate ? Date.parse(lease.moveOutDate) || nowMs : nowMs;
    const monthsOccupied = Math.max(1, startIso ? monthsBetween(startIso, endMs) : 1);

    const net = netPosition({
      collected: summary.collected,
      concessions,
      badDebt,
      legal,
      utilityExposure: 0,
      maintenanceEstimate: 0,
    });

    const leaseActions = actionsByLease.get(lease.id) ?? [];
    const has = (kind: DelinquencyAction["kind"]) => leaseActions.some((a) => a.kind === kind);
    const bucket = unit && lease.isCurrentLease ? agingBucket(unit) : null;
    const promise = promises.get(lease.id) ?? null;

    out.push({
      leaseId: lease.id,
      unitId: lease.unitId ?? null,
      unitNumber: lease.unitNumber || unit?.unitNumber || "",
      tenantName: unit && lease.isCurrentLease ? unit.tenantNames.join(", ") : "",
      leasingAgent: lease.leasingAgent,
      isCurrentLease: lease.isCurrentLease,
      evicted,
      moveInDate: startIso,
      monthsOccupied,
      billed: summary.billed,
      collected: summary.collected,
      openBalance,
      concessions,
      badDebt,
      legal,
      utilityExposure: 0,
      maintenanceEstimate: 0,
      net,
      verdict: verdictFor(net, monthsOccupied),
      collectionRate: summary.billed > 0 ? summary.collected / summary.billed : 1,
      timesLate: n(unit?.timesLate),
      promise,
      suggestion:
        openBalance > 0 || evicted
          ? suggestNextAction({
              bucket,
              evicted,
              hasFedFiled: has("fed_filed"),
              hasEvictionCompleted: has("eviction_completed"),
              hasNoticeServed: has("notice_served"),
              hasWriteoff: has("writeoff"),
              hasAnyAction: leaseActions.length > 0,
              promiseState: promise?.state ?? null,
              balance: openBalance,
            })
          : null,
    });
  }
  return out;
}

export interface TenantBands {
  /** Net-loss leases, deepest loss first. */
  losses: TenantPnl[];
  /** Contrast band: the best profitable leases, highest net first. */
  topPerformers: TenantPnl[];
  /** Everything else, net ascending (marginal cases surface first). */
  rest: TenantPnl[];
}

export const TOP_PERFORMER_COUNT = 3;

/** Rank the P&L list: losses first, then a small top-performer contrast band. */
export function tenantBands(pnls: readonly TenantPnl[]): TenantBands {
  const losses = pnls.filter((p) => p.verdict === "loss").sort((a, b) => a.net - b.net);
  const profitable = pnls.filter((p) => p.verdict === "profitable").sort((a, b) => b.net - a.net);
  const topPerformers = profitable.slice(0, TOP_PERFORMER_COUNT);
  const top = new Set(topPerformers.map((p) => p.leaseId));
  const rest = pnls
    .filter((p) => p.verdict !== "loss" && !top.has(p.leaseId))
    .sort((a, b) => a.net - b.net);
  return { losses, topPerformers, rest };
}

// ---- agent scorecards ------------------------------------------------------

/** leaseId → "YYYY-MM-DD" of the last payment, from the ledger summaries. */
export function lastPaymentMap(summaries: readonly LeaseLedgerSummary[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of summaries) {
    if (s.lastPaymentDate) out.set(s.leaseId, dateOnly(s.lastPaymentDate));
  }
  return out;
}

/**
 * Map synced rows to @emberly/core's AgentLeaseInput. `evicted` is derived
 * here (core deliberately parses no strings): the lease's unit carries a
 * delinquency reason matching /evict/i, the lease status matches /evict/i, or
 * an eviction_completed action was logged against the lease.
 */
export function agentLeaseInputs(
  leases: readonly ManagerLease[],
  units: readonly DelinquentUnit[],
  summaries: readonly LeaseLedgerSummary[],
  actions: readonly DelinquencyAction[],
): AgentLeaseInput[] {
  const unitById = new Map(units.map((u) => [u.unitId, u]));
  const summaryByLease = new Map(summaries.map((s) => [s.leaseId, s]));
  const evictionActionLeases = new Set(
    actions.filter((a) => a.kind === "eviction_completed").map((a) => a.resmanLeaseId),
  );

  return leases.map((lease) => {
    const unit = lease.unitId ? unitById.get(lease.unitId) : undefined;
    const evicted =
      EVICT_RE.test(lease.status) ||
      evictionActionLeases.has(lease.id) ||
      (lease.isCurrentLease && unit !== undefined && EVICT_RE.test(unit.delinquencyReason));
    return {
      leasingAgent: lease.leasingAgent,
      isCurrentLease: lease.isCurrentLease,
      applicationDate: lease.applicationDate ?? null,
      startDate: lease.startDate ?? null,
      moveInDate: lease.moveInDate ?? null,
      balance: lease.balance ?? null,
      residentRent: lease.residentRent ?? null,
      evicted,
      firstLateMonth: summaryByLease.get(lease.id)?.firstLateMonth ?? null,
      // A renewal keeps the ORIGINAL move-in date while its term starts a year
      // on, so the gap between the two is what tells them apart.
      isRenewal: isRenewalLease({ startDate: lease.startDate, moveInDate: lease.moveInDate }),
    };
  });
}

export interface AgentBoard {
  stats: AgentStat[];
  totalSigned: number;
  /** EVERY eviction on the property, including leases with no agent recorded. */
  totalEvictions: number;
  /** totalEvictions over tenancies that actually started. */
  overallEvictionRate: number;
  overallDelinquencyLoad: number;
  /** Tenancies (a lease someone moved into) — the eviction-rate denominator. */
  totalTenancies: number;
  /** Leases carrying no leasing agent, so absent from every scorecard above. */
  unattributedLeases: number;
  /** Evictions among them — the share of the problem no scorecard shows. */
  unattributedEvictions: number;
}

/** Agents mode header + scorecard list, via @emberly/core's buildAgentStats. */
export function buildAgentBoard(
  leases: readonly ManagerLease[],
  units: readonly DelinquentUnit[],
  summaries: readonly LeaseLedgerSummary[],
  actions: readonly DelinquencyAction[],
  opts: { windowMonths: number; nowMs: number },
): AgentBoard {
  const inputs = agentLeaseInputs(leases, units, summaries, actions);
  const stats = buildAgentStats(inputs, opts);
  const totalSigned = stats.reduce((acc, s) => acc + s.leasesSigned, 0);
  const delinquentBalance = stats.reduce((acc, s) => acc + s.delinquentBalance, 0);
  const activeRent = inputs
    .filter((i) => i.isCurrentLease && i.leasingAgent.trim() !== "")
    .reduce((acc, i) => acc + Math.max(0, i.residentRent ?? 0), 0);

  // The property's eviction figure counts EVERY eviction, not just the ones a
  // scorecard could claim. buildAgentStats skips leases with no leasing agent,
  // and ResMan only began recording one recently — 87% of leases starting in
  // 2026 carry an agent against 12% of 2025's — so summing the scorecards hid
  // 98 of the property's 153 evictions and reported 7.8% where the real figure
  // is 12.6%.
  //
  // The denominator is tenancies, not leases: a denied or cancelled
  // application was never a tenancy and could never have ended in an eviction,
  // so counting it only dilutes the rate.
  const tenancy = (i: AgentLeaseInput) => (i.moveInDate ?? "").trim() !== "";
  const tenancies = inputs.filter(tenancy);
  const totalEvictions = inputs.filter((i) => i.evicted === true).length;
  const unattributed = inputs.filter((i) => i.leasingAgent.trim() === "");

  return {
    stats,
    totalSigned,
    totalEvictions,
    overallEvictionRate: tenancies.length > 0 ? totalEvictions / tenancies.length : 0,
    overallDelinquencyLoad: activeRent > 0 ? delinquentBalance / activeRent : 0,
    totalTenancies: tenancies.length,
    unattributedLeases: unattributed.length,
    unattributedEvictions: unattributed.filter((i) => i.evicted === true).length,
  };
}

// ---- agent drill-in --------------------------------------------------------

export const FIRST_LATE_DELAY_BUCKETS = ["0-30d", "31-60", "61-90", "91-180", "181-365", "1yr+"] as const;

/** Months-since-move-in delta → histogram bucket index (0..5). */
export function firstLateDelayBucket(monthsDelta: number): number {
  if (monthsDelta <= 0) return 0;
  if (monthsDelta === 1) return 1;
  if (monthsDelta === 2) return 2;
  if (monthsDelta <= 6) return 3;
  if (monthsDelta <= 12) return 4;
  return 5;
}

const monthIdx = (value: string): number | null => {
  const m = /^(\d{4})-(\d{2})/.exec(value.trim());
  return m ? Number(m[1]) * 12 + (Number(m[2]) - 1) : null;
};

export interface AgentEvictionRow {
  leaseId: string;
  unitNumber: string;
  signed: string | null;
  firstLateMonth: string | null;
  balance: number;
}

export interface AgentDrillIn {
  /** The agent's evicted leases, worst balance first. */
  evictions: AgentEvictionRow[];
  /** Histogram over FIRST_LATE_DELAY_BUCKETS of when delinquencies first appear. */
  histogram: number[];
  delinquentNow: number;
  openDelinquent: number;
}

/** The drill-in sheet's data for one agent. */
export function agentDrillIn(
  agent: string,
  leases: readonly ManagerLease[],
  units: readonly DelinquentUnit[],
  summaries: readonly LeaseLedgerSummary[],
  actions: readonly DelinquencyAction[],
): AgentDrillIn {
  const unitById = new Map(units.map((u) => [u.unitId, u]));
  const summaryByLease = new Map(summaries.map((s) => [s.leaseId, s]));
  const evictionActionLeases = new Set(
    actions.filter((a) => a.kind === "eviction_completed").map((a) => a.resmanLeaseId),
  );
  const mine = leases.filter((l) => l.leasingAgent.trim() === agent);

  const histogram = FIRST_LATE_DELAY_BUCKETS.map(() => 0);
  const evictions: AgentEvictionRow[] = [];
  let delinquentNow = 0;
  let openDelinquent = 0;

  for (const lease of mine) {
    const unit = lease.unitId ? unitById.get(lease.unitId) : undefined;
    const summary = summaryByLease.get(lease.id);
    const evicted =
      EVICT_RE.test(lease.status) ||
      evictionActionLeases.has(lease.id) ||
      (lease.isCurrentLease && unit !== undefined && EVICT_RE.test(unit.delinquencyReason));

    if (lease.isCurrentLease && (lease.balance ?? 0) > 0) {
      delinquentNow += 1;
      openDelinquent += lease.balance ?? 0;
    }

    if (evicted) {
      evictions.push({
        leaseId: lease.id,
        unitNumber: lease.unitNumber,
        // Not moveInDate: on a renewal that is the ORIGINAL move-in, which
        // dated a 2026 lease to 2020.
        signed: lease.applicationDate ?? lease.startDate ?? lease.moveInDate ?? null,
        firstLateMonth: summary?.firstLateMonth ?? null,
        balance: Math.max(0, lease.balance ?? 0),
      });
    }

    // Anchored on the start of THIS lease term, not the original move-in.
    // On a renewal those differ by years: a resident who arrived in 2020, was
    // renewed in July 2026 and first went late that same month landed in the
    // "1yr+" bucket, so brand-new delinquency read as ancient history on the
    // agent who signed the renewal.
    const anchor = lease.startDate ?? lease.moveInDate;
    const termStart = anchor ? monthIdx(anchor) : null;
    const late = summary?.firstLateMonth ? monthIdx(summary.firstLateMonth) : null;
    if (termStart !== null && late !== null && late >= termStart) {
      histogram[firstLateDelayBucket(late - termStart)] += 1;
    }
  }

  evictions.sort((a, b) => b.balance - a.balance);
  return { evictions, histogram, delinquentNow, openDelinquent };
}

// ---- interleaved ledger + action timeline ----------------------------------

export type TimelineItem =
  | { type: "ledger"; key: string; dateIso: string; entry: LedgerEntry; ord: number }
  | { type: "action"; key: string; dateIso: string; action: DelinquencyAction; ord: number };

/**
 * Interleave a lease's ledger entries with its logged actions on one
 * newest-first timeline. Ledger entries sort by their date; actions by
 * createdAt (date portion), with actions winning ties so the human record of
 * a day reads above that day's charges.
 */
export function buildTimeline(
  entries: readonly LedgerEntry[],
  actions: readonly DelinquencyAction[],
  leaseId: string,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  // The server returns the ledger in ResMan's own order (date desc, then
  // ledger_sequence desc). That order is what makes the running balance read
  // as a tab, and several entries routinely share one date — so the incoming
  // position is kept as the tiebreak. Sorting same-day rows by id instead put
  // a $718 rent charge above the late fee that followed it and made the
  // balance column appear to jump backwards.
  let ord = 0;
  for (const entry of entries) {
    if (!entry.date) continue;
    items.push({ type: "ledger", key: `l-${entry.id}`, dateIso: dateOnly(entry.date), entry, ord: ord++ });
  }
  for (const action of actions) {
    if (action.resmanLeaseId !== leaseId || !action.createdAt) continue;
    items.push({ type: "action", key: `a-${action.id}`, dateIso: dateOnly(action.createdAt), action, ord: ord++ });
  }
  items.sort((a, b) => {
    const cmp = b.dateIso.localeCompare(a.dateIso);
    if (cmp !== 0) return cmp;
    if (a.type !== b.type) return a.type === "action" ? -1 : 1;
    return a.ord - b.ord;
  });
  return items;
}
