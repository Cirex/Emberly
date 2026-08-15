/**
 * Per-leasing-agent quality stats for the manager app. Pure aggregation over
 * lease rows the caller maps from synced ResMan data — no I/O, no parsing of
 * status text (the caller derives booleans like `evicted` upstream).
 */

/**
 * The minimal lease row buildAgentStats reads. The caller must map:
 *  - leasingAgent: the agent's display name (rows with a blank name are
 *    skipped — attribute or filter "Unassigned" upstream if wanted).
 *  - isCurrentLease: whether this row is the unit's active lease.
 *  - applicationDate / moveInDate: ISO-ish date strings ("YYYY-MM-DD...");
 *    applicationDate is the signing date, moveInDate is the fallback.
 *  - balance: current amount owed on the lease.
 *  - residentRent: the lease's actual rent (denominator of delinquencyLoad).
 *  - evicted: precomputed upstream (e.g. from delinquency_reason/status
 *    text) — this module deliberately does NOT parse strings.
 *  - firstLateMonth: "YYYY-MM" of the first late payment, null/absent when
 *    the tenant has never been late.
 *
 *  - isRenewal: whether this lease renews a sitting resident rather than
 *    bringing a new one in. Derive it with `isRenewalLease` (below) or supply
 *    it directly; absent means "treat as a move-in".
 */
export interface AgentLeaseInput {
  leasingAgent: string;
  isCurrentLease: boolean;
  applicationDate?: string | null;
  /** When THIS lease term began. The signing fallback for a renewal. */
  startDate?: string | null;
  moveInDate?: string | null;
  balance?: number | null;
  residentRent?: number | null;
  evicted?: boolean;
  firstLateMonth?: string | null;
  isRenewal?: boolean;
}

/**
 * Days a lease's term must start AFTER the resident moved in before it counts
 * as a renewal rather than a new tenancy.
 *
 * A new move-in's term starts the day they get the keys; a renewal's term
 * starts a year or more later while `move_in_date` keeps pointing at the
 * ORIGINAL move-in, because ResMan carries it forward. The gap is what
 * separates them, and in the mirror it is not a judgement call — of 1,042
 * leases carrying both dates, 653 start within a day of move-in and 379 start
 * 200+ days after. Only 10 land anywhere in between, so the threshold has a
 * month of slack on either side of anything real.
 *
 * Corroborated against statuses the classifier never sees: all 29 Pending
 * Renewal and both Month to Month leases come out renewals, and all 113 Denied
 * applications come out move-ins.
 */
export const RENEWAL_MIN_GAP_DAYS = 31;

const DAY_MS = 86_400_000;

/**
 * Whether a lease renews a sitting resident. False when either date is missing
 * — an unknown is treated as a new tenancy, which is the conservative side:
 * it attributes the lease to the agent's screening rather than excusing it.
 */
export function isRenewalLease(lease: {
  startDate?: string | null;
  moveInDate?: string | null;
}): boolean {
  const start = lease.startDate ? localDateMs(lease.startDate) : null;
  const moveIn = lease.moveInDate ? localDateMs(lease.moveInDate) : null;
  if (start === null || moveIn === null) return false;
  return (start - moveIn) / DAY_MS > RENEWAL_MIN_GAP_DAYS;
}

/** One side of the move-in / renewal split. */
export interface AgentSplit {
  /** Leases of this kind attributed to the agent (all-time). */
  total: number;
  /** Leases of this kind whose signing date falls in the window. */
  signed: number;
  /** Currently active leases of this kind. */
  active: number;
  /** Active leases of this kind with balance > 0. */
  delinquentCount: number;
  /** Sum of those balances. */
  delinquentBalance: number;
  /** delinquentBalance / sum of this kind's active rent (0 when rent sum is 0). */
  delinquencyLoad: number;
}

export interface AgentStat {
  agent: string;
  /** Leases whose signing date (applicationDate, else moveInDate) falls within the window. */
  leasesSigned: number;
  /** Currently active leases. */
  active: number;
  /** Leases marked evicted (all-time, not windowed). */
  evictions: number;
  /** evictions / total leases attributed to the agent (0 when no leases). */
  evictionRate: number;
  /** Active leases with balance > 0. */
  delinquentCount: number;
  /** Sum of those balances. */
  delinquentBalance: number;
  /** delinquentBalance / sum of active leases' residentRent (0 when rent sum is 0). */
  delinquencyLoad: number;
  /**
   * The same active-lease delinquency, split by what the agent actually did.
   *
   * A move-in is the agent's own screening decision; a renewal is a resident
   * someone else placed, whom this agent chose to keep. Blending them hides
   * both signals — across the property, move-ins run 34% delinquent at $1,123
   * average while renewals run 24% at $567, so an agent's blended number moves
   * mostly with their renewal share rather than their judgement.
   */
  moveIn: AgentSplit;
  renewal: AgentSplit;
  /**
   * Share of MOVE-INS whose first late payment came within 3 months (0 when no
   * dated move-ins). Renewals are excluded from the denominator: a renewal's
   * move-in date is the original one, often years back, so it could never
   * default "early" and only diluted the rate.
   */
  earlyDefaultRate: number;
  /** True when leasesSigned < LOW_VOLUME_THRESHOLD — rates are noisy, downrank visually. */
  lowVolume: boolean;
}

/** Below this many signed-in-window leases an agent's rates are flagged as low-volume. */
export const LOW_VOLUME_THRESHOLD = 12;

/** Months after move-in within which a first late payment counts as an early default. */
export const EARLY_DEFAULT_MONTHS = 3;

/** Parse the leading YYYY-MM of a date-ish string to an absolute month index. */
function monthIndex(value: string): number | null {
  const m = /^(\d{4})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
}

/** Parse a date-only string as LOCAL midnight (UTC parsing shifts a day back). */
function localDateMs(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/**
 * Composite risk used for ordering (lower = better agent):
 *   3 * evictionRate + 2 * earlyDefaultRate + min(delinquencyLoad, 1)
 * Evictions are the costliest outcome so they weigh most; early defaults are
 * a leasing-screening signal; delinquency load is capped at 1 so one whale
 * balance can't swamp the ordering.
 */
function riskScore(s: AgentStat): number {
  return 3 * s.evictionRate + 2 * s.earlyDefaultRate + Math.min(s.delinquencyLoad, 1);
}

export interface AgentStatsOptions {
  /** Signing window for leasesSigned / lowVolume, counted back from nowMs. */
  windowMonths: number;
  nowMs: number;
}

/**
 * Aggregate leases into one AgentStat per (non-blank) leasingAgent.
 *
 * Ordering: ascending riskScore (see above) — best agents first — then
 * leasesSigned descending (volume breaks ties in favor of proven agents),
 * then agent name ascending for stability.
 */
export function buildAgentStats(leases: AgentLeaseInput[], opts: AgentStatsOptions): AgentStat[] {
  const now = new Date(opts.nowMs);
  const windowStartMs = new Date(now.getFullYear(), now.getMonth() - opts.windowMonths, now.getDate()).getTime();

  interface SplitAcc {
    total: number;
    signed: number;
    active: number;
    delinquentCount: number;
    delinquentBalance: number;
    activeRentSum: number;
  }
  interface Acc {
    total: number;
    signed: number;
    active: number;
    evictions: number;
    delinquentCount: number;
    delinquentBalance: number;
    activeRentSum: number;
    /** Denominator of earlyDefaultRate: dated MOVE-INS only, never renewals. */
    datedMoveIns: number;
    earlyDefaults: number;
    moveIn: SplitAcc;
    renewal: SplitAcc;
  }
  const emptySplit = (): SplitAcc => ({
    total: 0,
    signed: 0,
    active: 0,
    delinquentCount: 0,
    delinquentBalance: 0,
    activeRentSum: 0,
  });
  const byAgent = new Map<string, Acc>();

  for (const lease of leases) {
    const agent = lease.leasingAgent.trim();
    if (!agent) continue;
    let acc = byAgent.get(agent);
    if (!acc) {
      acc = {
        total: 0,
        signed: 0,
        active: 0,
        evictions: 0,
        delinquentCount: 0,
        delinquentBalance: 0,
        activeRentSum: 0,
        datedMoveIns: 0,
        earlyDefaults: 0,
        moveIn: emptySplit(),
        renewal: emptySplit(),
      };
      byAgent.set(agent, acc);
    }

    const isRenewal = lease.isRenewal === true;
    const split = isRenewal ? acc.renewal : acc.moveIn;

    acc.total += 1;
    split.total += 1;
    if (lease.evicted) acc.evictions += 1;

    // A renewal carries no application date — nobody applied, they already
    // live there — so this fell through to the move-in date, which on a
    // renewal is the ORIGINAL one. An agent's July 2026 renewal of a resident
    // who arrived in 2020 was dated 2020: outside every signing window, so it
    // never counted as work they did. `startDate` is when THIS term began and
    // is the right fallback; on a new move-in it equals the move-in date
    // anyway, so nothing else moves.
    const signedRaw = lease.applicationDate ?? lease.startDate ?? lease.moveInDate;
    const signedMs = signedRaw ? localDateMs(signedRaw) : null;
    if (signedMs !== null && signedMs >= windowStartMs) {
      acc.signed += 1;
      split.signed += 1;
    }

    if (lease.isCurrentLease) {
      acc.active += 1;
      split.active += 1;
      if (typeof lease.residentRent === "number" && lease.residentRent > 0) {
        acc.activeRentSum += lease.residentRent;
        split.activeRentSum += lease.residentRent;
      }
      if (typeof lease.balance === "number" && lease.balance > 0) {
        acc.delinquentCount += 1;
        acc.delinquentBalance += lease.balance;
        split.delinquentCount += 1;
        split.delinquentBalance += lease.balance;
      }
    }

    // Early default is a screening signal, so only a real move-in can have one.
    const moveInIdx = !isRenewal && lease.moveInDate ? monthIndex(lease.moveInDate) : null;
    if (moveInIdx !== null) {
      acc.datedMoveIns += 1;
      const lateIdx = lease.firstLateMonth ? monthIndex(lease.firstLateMonth) : null;
      if (lateIdx !== null && lateIdx - moveInIdx >= 0 && lateIdx - moveInIdx <= EARLY_DEFAULT_MONTHS) {
        acc.earlyDefaults += 1;
      }
    }
  }

  const finishSplit = (s: SplitAcc): AgentSplit => ({
    total: s.total,
    signed: s.signed,
    active: s.active,
    delinquentCount: s.delinquentCount,
    delinquentBalance: s.delinquentBalance,
    delinquencyLoad: s.activeRentSum > 0 ? s.delinquentBalance / s.activeRentSum : 0,
  });

  const stats: AgentStat[] = [...byAgent.entries()].map(([agent, a]) => ({
    agent,
    leasesSigned: a.signed,
    active: a.active,
    evictions: a.evictions,
    evictionRate: a.total > 0 ? a.evictions / a.total : 0,
    delinquentCount: a.delinquentCount,
    delinquentBalance: a.delinquentBalance,
    delinquencyLoad: a.activeRentSum > 0 ? a.delinquentBalance / a.activeRentSum : 0,
    moveIn: finishSplit(a.moveIn),
    renewal: finishSplit(a.renewal),
    earlyDefaultRate: a.datedMoveIns > 0 ? a.earlyDefaults / a.datedMoveIns : 0,
    lowVolume: a.signed < LOW_VOLUME_THRESHOLD,
  }));

  stats.sort(
    (x, y) =>
      riskScore(x) - riskScore(y) || y.leasesSigned - x.leasesSigned || x.agent.localeCompare(y.agent),
  );
  return stats;
}
