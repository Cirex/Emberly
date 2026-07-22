import type { InsuranceAction, InsurancePolicy } from "@/lib/api/insurance";
import { shortPct, TINT, type ScoreMetric } from "@/lib/derived/leasing";
import { addDays, calendarDaysBetween, parseDay, startOfDay } from "@/lib/derived/time";

/**
 * The insurance-compliance derived engine — pure functions turning the
 * per-lease policy feed + the Emberly follow-up trail into the mockup's
 * board. No I/O, no store imports, no JSX; tests in
 * tests/insurance-view.test.ts.
 *
 * COMPLIANCE IS A DATE COMPARISON (build note): lapsed = end_date in the
 * past; expiring = within 30 days; never filed = no policy row. No
 * inference, no new pipeline. A policy on file with NO end date has nothing
 * to compare, so it counts as covered rather than inventing a lapse.
 *
 * "NEVER FILED" IS HONEST (build note): leases with no policy row get their
 * own band, deliberately separate from lapsed — many predate the insurance
 * requirement, and conflating the two would produce a scary number nobody
 * trusts and therefore nobody acts on.
 */

// ── Constants ───────────────────────────────────────────────────────────────

/** A policy ending within this many days is "expiring". */
export const INSURANCE_EXPIRING_DAYS = 30;
/** The "N in the next week" caption's window. */
export const INSURANCE_WEEK_DAYS = 7;

export type InsuranceStatus = "covered" | "expiring" | "lapsed" | "neverFiled";

// ── Status ──────────────────────────────────────────────────────────────────

/**
 * One lease's compliance status, straight from the mockup's semantics:
 *  - neverFiled — no policy row at all (policyId null);
 *  - lapsed    — end date strictly in the past;
 *  - expiring  — end date within INSURANCE_EXPIRING_DAYS (today inclusive);
 *  - covered   — end date beyond the window, or a policy with no end date.
 */
export function insuranceStatus(policy: InsurancePolicy, nowMs: number): InsuranceStatus {
  if (!policy.policyId) return "neverFiled";
  const endMs = parseDay(policy.endDate);
  if (endMs === null) return "covered";
  const daysLeft = calendarDaysBetween(startOfDay(nowMs), endMs);
  if (daysLeft < 0) return "lapsed";
  if (daysLeft <= INSURANCE_EXPIRING_DAYS) return "expiring";
  return "covered";
}

// ── Actions index ───────────────────────────────────────────────────────────

/** Best-effort event ms for ordering actions. */
export function actionMs(action: InsuranceAction): number | null {
  if (!action.createdAt) return null;
  const ms = Date.parse(action.createdAt);
  return Number.isFinite(ms) ? ms : null;
}

/** All actions for each lease, newest first. */
export function actionsByLease(
  actions: readonly InsuranceAction[],
): Map<string, InsuranceAction[]> {
  const map = new Map<string, InsuranceAction[]>();
  for (const action of actions) {
    const list = map.get(action.resmanLeaseId);
    if (list) list.push(action);
    else map.set(action.resmanLeaseId, [action]);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (actionMs(b) ?? 0) - (actionMs(a) ?? 0));
  }
  return map;
}

// ── The banded board ────────────────────────────────────────────────────────

export interface InsuranceRowView {
  policy: InsurancePolicy;
  status: InsuranceStatus;
  /** First tenant name from the unit mirror, "" when unknown. */
  tenantName: string;
  endMs: number | null;
  /** Whole days until the end date (expiring/covered rows; null otherwise). */
  daysLeft: number | null;
  /** Whole days since the end date passed (lapsed rows; null otherwise). */
  daysSinceLapse: number | null;
  /** Move-in (else lease start) as local-midnight ms — never-filed context. */
  leaseStartMs: number | null;
  /** The lease's LATEST proof_requested action, if any. */
  lastProofRequest: InsuranceAction | null;
  /** Whole days since that request (0 when its timestamp is unknown). */
  daysSinceRequest: number | null;
}

/** The four-segment coverage bar's counts (none = never filed). */
export interface CoverageDistribution {
  covered: number;
  expiring: number;
  lapsed: number;
  none: number;
  total: number;
}

export interface InsuranceBoard {
  /** Every current lease's row, in feed order. */
  rows: InsuranceRowView[];
  /** LAPSED · UNINSURED TODAY — longest-lapsed first. */
  lapsed: InsuranceRowView[];
  /** EXPIRING ≤ 30 DAYS — soonest end first. */
  expiring: InsuranceRowView[];
  /** NEVER FILED — its own band, by unit number. */
  neverFiled: InsuranceRowView[];
  distribution: CoverageDistribution;
  /** Lapsed + expiring — the mode pill and the "Needs action" chip. */
  needsAction: number;
  /** Expiring rows ending within the next week (caption). */
  expiringWeek: number;
  /** Leases with coverage today (covered + expiring — still insured now). */
  coveredToday: number;
  /** coveredToday / total × 100 (0 when there are no leases). */
  coveredPct: number;
  total: number;
}

/** One policy row + the follow-up trail → the derived row view. */
export function insuranceRowView(
  policy: InsurancePolicy,
  leaseActions: readonly InsuranceAction[],
  nowMs: number,
): InsuranceRowView {
  const today = startOfDay(nowMs);
  const status = insuranceStatus(policy, nowMs);
  const endMs = parseDay(policy.endDate);
  const days = endMs !== null ? calendarDaysBetween(today, endMs) : null;
  const lastProofRequest = leaseActions.find((a) => a.kind === "proof_requested") ?? null;
  const requestMs = lastProofRequest ? actionMs(lastProofRequest) : null;
  return {
    policy,
    status,
    tenantName: policy.tenantNames[0] ?? "",
    endMs,
    daysLeft: days !== null && days >= 0 ? days : null,
    daysSinceLapse: days !== null && days < 0 ? -days : null,
    leaseStartMs: parseDay(policy.leaseStart),
    lastProofRequest,
    daysSinceRequest:
      lastProofRequest === null
        ? null
        : requestMs !== null
          ? Math.max(0, calendarDaysBetween(requestMs, today))
          : 0,
  };
}

/**
 * Assemble the Compliance board: statuses per lease, the coverage
 * distribution, and the three bands — LAPSED (longest-lapsed first, so the
 * oldest uninsured exposure tops the list), EXPIRING ≤ 30 (soonest end
 * first), NEVER FILED (by unit number).
 */
export function buildInsuranceBoard(
  policies: readonly InsurancePolicy[],
  actions: readonly InsuranceAction[],
  nowMs: number,
): InsuranceBoard {
  const byLease = actionsByLease(actions);
  const rows = policies.map((p) => insuranceRowView(p, byLease.get(p.leaseId) ?? [], nowMs));

  const lapsed = rows
    .filter((r) => r.status === "lapsed")
    .sort((a, b) => (b.daysSinceLapse ?? 0) - (a.daysSinceLapse ?? 0));
  const expiring = rows
    .filter((r) => r.status === "expiring")
    .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
  const neverFiled = rows
    .filter((r) => r.status === "neverFiled")
    .sort((a, b) => a.policy.unitNumber.localeCompare(b.policy.unitNumber));
  const covered = rows.filter((r) => r.status === "covered").length;

  const total = rows.length;
  const coveredToday = covered + expiring.length;
  return {
    rows,
    lapsed,
    expiring,
    neverFiled,
    distribution: {
      covered,
      expiring: expiring.length,
      lapsed: lapsed.length,
      none: neverFiled.length,
      total,
    },
    needsAction: lapsed.length + expiring.length,
    expiringWeek: expiring.filter(
      (r) => r.daysLeft !== null && r.daysLeft <= INSURANCE_WEEK_DAYS,
    ).length,
    coveredToday,
    coveredPct: total > 0 ? (coveredToday / total) * 100 : 0,
    total,
  };
}

/** The three header metrics: Covered % · Lapsed · Expiring 30d. */
export function buildInsuranceMetrics(board: InsuranceBoard): ScoreMetric[] {
  return [
    {
      key: "covered",
      value: shortPct(board.coveredPct),
      tint: TINT.green,
      labelKey: "leasing.compliance.metrics.covered",
      captionKey: "leasing.compliance.metrics.coveredCaption",
      captionParams: { covered: board.coveredToday, total: board.total },
    },
    {
      key: "lapsed",
      value: String(board.lapsed.length),
      tint: TINT.red,
      labelKey: "leasing.compliance.metrics.lapsed",
      captionKey: "leasing.compliance.metrics.lapsedCaption",
    },
    {
      key: "expiring",
      value: String(board.expiring.length),
      tint: TINT.amber,
      labelKey: "leasing.compliance.metrics.expiring30",
      captionKey: "leasing.compliance.metrics.expiring30Caption",
      captionParams: { week: board.expiringWeek },
    },
  ];
}

// ── Detail-sheet timeline ───────────────────────────────────────────────────

export type InsuranceTimelineItem =
  | { key: string; kind: "action"; action: InsuranceAction; whenMs: number | null }
  | { key: "lapse"; kind: "lapseDetected"; whenMs: number };

/**
 * The sheet's COMPLIANCE LOG, newest first: the lease's stored actions
 * interleaved with ONE derived "Lapse detected" entry — automatic, from the
 * policy end date (the day after it), never a stored row. Present only while
 * the policy is actually lapsed.
 */
export function buildInsuranceTimeline(
  row: InsuranceRowView,
  leaseActions: readonly InsuranceAction[],
): InsuranceTimelineItem[] {
  const items: InsuranceTimelineItem[] = leaseActions.map((action) => ({
    key: `action-${action.id}`,
    kind: "action",
    action,
    whenMs: actionMs(action),
  }));
  if (row.status === "lapsed" && row.endMs !== null) {
    items.push({ key: "lapse", kind: "lapseDetected", whenMs: addDays(row.endMs, 1) });
  }
  return items.sort((a, b) => (b.whenMs ?? 0) - (a.whenMs ?? 0));
}
