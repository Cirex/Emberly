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
 * A renewal proxy is intentionally omitted: it would need per-lease renewal
 * linkage (or reliable end/start chaining) that the synced data doesn't
 * carry yet, so status/endDate/marketRent are not part of this input.
 */
export interface AgentLeaseInput {
  leasingAgent: string;
  isCurrentLease: boolean;
  applicationDate?: string | null;
  moveInDate?: string | null;
  balance?: number | null;
  residentRent?: number | null;
  evicted?: boolean;
  firstLateMonth?: string | null;
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
  /** Share of move-ins whose first late payment came within 3 months (0 when no dated move-ins). */
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

  interface Acc {
    total: number;
    signed: number;
    active: number;
    evictions: number;
    delinquentCount: number;
    delinquentBalance: number;
    activeRentSum: number;
    moveIns: number;
    earlyDefaults: number;
  }
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
        moveIns: 0,
        earlyDefaults: 0,
      };
      byAgent.set(agent, acc);
    }

    acc.total += 1;
    if (lease.evicted) acc.evictions += 1;

    const signedRaw = lease.applicationDate ?? lease.moveInDate;
    const signedMs = signedRaw ? localDateMs(signedRaw) : null;
    if (signedMs !== null && signedMs >= windowStartMs) acc.signed += 1;

    if (lease.isCurrentLease) {
      acc.active += 1;
      if (typeof lease.residentRent === "number" && lease.residentRent > 0) acc.activeRentSum += lease.residentRent;
      if (typeof lease.balance === "number" && lease.balance > 0) {
        acc.delinquentCount += 1;
        acc.delinquentBalance += lease.balance;
      }
    }

    const moveInIdx = lease.moveInDate ? monthIndex(lease.moveInDate) : null;
    if (moveInIdx !== null) {
      acc.moveIns += 1;
      const lateIdx = lease.firstLateMonth ? monthIndex(lease.firstLateMonth) : null;
      if (lateIdx !== null && lateIdx - moveInIdx >= 0 && lateIdx - moveInIdx <= EARLY_DEFAULT_MONTHS) {
        acc.earlyDefaults += 1;
      }
    }
  }

  const stats: AgentStat[] = [...byAgent.entries()].map(([agent, a]) => ({
    agent,
    leasesSigned: a.signed,
    active: a.active,
    evictions: a.evictions,
    evictionRate: a.total > 0 ? a.evictions / a.total : 0,
    delinquentCount: a.delinquentCount,
    delinquentBalance: a.delinquentBalance,
    delinquencyLoad: a.activeRentSum > 0 ? a.delinquentBalance / a.activeRentSum : 0,
    earlyDefaultRate: a.moveIns > 0 ? a.earlyDefaults / a.moveIns : 0,
    lowVolume: a.signed < LOW_VOLUME_THRESHOLD,
  }));

  stats.sort(
    (x, y) =>
      riskScore(x) - riskScore(y) || y.leasesSigned - x.leasesSigned || x.agent.localeCompare(y.agent),
  );
  return stats;
}
