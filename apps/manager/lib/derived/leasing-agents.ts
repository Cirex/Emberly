import type { ManagerLease } from "@/lib/api/leases";
import { isActiveResidency, isDeadLease, TINT, type ScoreMetric } from "@/lib/derived/leasing";
import { DAY_MS, parseDay, startOfDay, startOfMonth } from "@/lib/derived/time";

/**
 * Leasing · Agents (mockup frame 10) — per-agent application PRODUCTION: how
 * many applications each leasing agent took this week / last week / this month,
 * how many became move-ins, the applied→moved-in funnel, and the median days
 * from application to keys. Read-only, derived from the lease mirror. Pairs
 * with Money · By Agent (that board is book quality after signature; this is
 * top-of-funnel production).
 */

const NINETY = 90;
/** An agent needs at least this many 90-day apps before flags/ranking apply. */
const MIN_VOLUME = 3;
/** Below this conversion, a producing agent is stalling. */
const STALLING_PCT = 25;
/** An unmoved application older than this reads as stalled. */
const STALL_DAYS = 7;
const APPS_WEEKS = 8;

/** Monday-start week containing `ms` (the manager's week convention). */
function startOfWeek(ms: number): number {
  const dow = new Date(startOfDay(ms)).getDay(); // 0 Sun … 6 Sat
  return startOfDay(ms) - ((dow + 6) % 7) * DAY_MS;
}

export type AgentFlag = "best" | "stalling" | "lowVolume" | null;

/** The applied → approved → signed → moved-in funnel over the 90-day book. */
export interface AgentFunnel {
  applied: number;
  approved: number;
  signed: number;
  movedIn: number;
}

export interface LeasingAgentRow {
  /** Display name; empty string is the office / unattributed bucket. */
  agent: string;
  isOffice: boolean;
  activeLeases: number;
  appsThisWeek: number;
  appsLastWeek: number;
  appsThisMonth: number;
  apps90: number;
  moveIns90: number;
  conversionPct: number | null;
  medianAppToKeysDays: number | null;
  funnel: AgentFunnel;
  /** 1 = most applications; null for the office bucket. */
  rank: number | null;
  flag: AgentFlag;
}

export interface StalledApplication {
  unitNumber: string;
  agent: string;
  ageDays: number;
}

export interface LeasingAgentBoard {
  rows: LeasingAgentRow[];
  appsThisWeek: number;
  appsLastWeek: number;
  appsThisMonth: number;
  apps90: number;
  moveIns90: number;
  conversionPct: number | null;
  medianAppToKeysDays: number | null;
  /** Start of last week, for the "wk of …" caption. */
  lastWeekStartMs: number;
  /** 8 weeks of applications, oldest → newest. */
  appsPerWeek: number[];
  stalled: StalledApplication[];
}

type Stage = "applied" | "approved" | "signed" | "movedIn";

function movedInMs(lease: ManagerLease, todayMs: number): number | null {
  const ms = parseDay(lease.moveInDate);
  return ms !== null && ms <= todayMs ? ms : null;
}

function stageOf(lease: ManagerLease, todayMs: number): Stage {
  if (movedInMs(lease, todayMs) !== null) return "movedIn";
  if (parseDay(lease.signedDate) !== null) return "signed";
  if (lease.approvalStatus.toLowerCase().includes("approv")) return "approved";
  return "applied";
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function buildLeasingAgentBoard(leases: ManagerLease[], nowMs: number): LeasingAgentBoard {
  const today = startOfDay(nowMs);
  const thisWeek = startOfWeek(nowMs);
  const lastWeek = thisWeek - 7 * DAY_MS;
  const thisMonth = startOfMonth(nowMs);
  const since90 = today - NINETY * DAY_MS;

  // Applications = leases with an application date; group by agent.
  const applied = leases.filter((l) => !isDeadLease(l) && parseDay(l.applicationDate) !== null);
  const byAgent = new Map<string, ManagerLease[]>();
  for (const lease of applied) {
    const key = lease.leasingAgent.trim();
    const arr = byAgent.get(key);
    if (arr) arr.push(lease);
    else byAgent.set(key, [lease]);
  }

  // Active-lease counts span every lease, not only applications.
  const activeByAgent = new Map<string, number>();
  for (const lease of leases) {
    if (!isActiveResidency(lease, nowMs)) continue;
    const key = lease.leasingAgent.trim();
    activeByAgent.set(key, (activeByAgent.get(key) ?? 0) + 1);
  }

  const inWindow = (lease: ManagerLease, from: number, to?: number): boolean => {
    const ms = parseDay(lease.applicationDate);
    return ms !== null && ms >= from && (to === undefined || ms < to);
  };

  let rows: LeasingAgentRow[] = [...byAgent.entries()].map(([agent, agentLeases]) => {
    const apps90List = agentLeases.filter((l) => inWindow(l, since90));
    const movedIn90 = apps90List.filter((l) => movedInMs(l, today) !== null);
    const funnel: AgentFunnel = { applied: 0, approved: 0, signed: 0, movedIn: 0 };
    for (const l of apps90List) funnel[stageOf(l, today)] += 1;
    const keysDays = movedIn90
      .map((l) => {
        const a = parseDay(l.applicationDate);
        const m = movedInMs(l, today);
        return a !== null && m !== null ? Math.round((m - a) / DAY_MS) : null;
      })
      .filter((d): d is number => d !== null);
    return {
      agent,
      isOffice: agent === "",
      activeLeases: activeByAgent.get(agent) ?? 0,
      appsThisWeek: agentLeases.filter((l) => inWindow(l, thisWeek)).length,
      appsLastWeek: agentLeases.filter((l) => inWindow(l, lastWeek, thisWeek)).length,
      appsThisMonth: agentLeases.filter((l) => inWindow(l, thisMonth)).length,
      apps90: apps90List.length,
      moveIns90: movedIn90.length,
      conversionPct: apps90List.length === 0 ? null : (movedIn90.length / apps90List.length) * 100,
      medianAppToKeysDays: median(keysDays),
      funnel,
      rank: null,
      flag: null,
    };
  });

  // Rank producers (office bucket always trails, unranked).
  const producers = rows.filter((r) => !r.isOffice).sort((a, b) => b.apps90 - a.apps90 || b.moveIns90 - a.moveIns90);
  producers.forEach((r, i) => (r.rank = i + 1));
  const bestConverter = producers
    .filter((r) => r.apps90 >= MIN_VOLUME && r.conversionPct !== null)
    .sort((a, b) => (b.conversionPct ?? 0) - (a.conversionPct ?? 0))[0];
  for (const r of rows) {
    if (r.isOffice || r.apps90 < MIN_VOLUME) r.flag = "lowVolume";
    else if (r === bestConverter) r.flag = "best";
    else if ((r.conversionPct ?? 100) < STALLING_PCT) r.flag = "stalling";
  }
  rows = [
    ...producers,
    ...rows.filter((r) => r.isOffice),
  ];

  // Property totals.
  const appsThisWeek = applied.filter((l) => inWindow(l, thisWeek)).length;
  const appsLastWeek = applied.filter((l) => inWindow(l, lastWeek, thisWeek)).length;
  const appsThisMonth = applied.filter((l) => inWindow(l, thisMonth)).length;
  const apps90All = applied.filter((l) => inWindow(l, since90));
  const moveIns90All = apps90All.filter((l) => movedInMs(l, today) !== null);
  const medianAll = median(
    moveIns90All
      .map((l) => {
        const a = parseDay(l.applicationDate);
        const m = movedInMs(l, today);
        return a !== null && m !== null ? Math.round((m - a) / DAY_MS) : null;
      })
      .filter((d): d is number => d !== null),
  );

  // 8-week application cadence.
  const appsPerWeek = Array.from({ length: APPS_WEEKS }, () => 0);
  for (const l of applied) {
    const ms = parseDay(l.applicationDate);
    if (ms === null) continue;
    const w = Math.floor((thisWeek - startOfWeek(ms)) / (7 * DAY_MS));
    if (w >= 0 && w < APPS_WEEKS) appsPerWeek[APPS_WEEKS - 1 - w] += 1;
  }

  // Stalled applications: still applied/approved and older than a week.
  const stalled: StalledApplication[] = applied
    .filter((l) => {
      const stage = stageOf(l, today);
      if (stage === "signed" || stage === "movedIn") return false;
      const ms = parseDay(l.applicationDate);
      return ms !== null && Math.round((today - ms) / DAY_MS) > STALL_DAYS;
    })
    .map((l) => ({
      unitNumber: l.unitNumber,
      agent: l.leasingAgent.trim(),
      ageDays: Math.round((today - (parseDay(l.applicationDate) as number)) / DAY_MS),
    }))
    .sort((a, b) => b.ageDays - a.ageDays)
    .slice(0, 5);

  return {
    rows,
    appsThisWeek,
    appsLastWeek,
    appsThisMonth,
    apps90: apps90All.length,
    moveIns90: moveIns90All.length,
    conversionPct: apps90All.length === 0 ? null : (moveIns90All.length / apps90All.length) * 100,
    medianAppToKeysDays: medianAll,
    lastWeekStartMs: lastWeek,
    appsPerWeek,
    stalled,
  };
}

/** The five KPIs the Agents board pins to the header strip. */
export function buildLeasingAgentMetrics(b: LeasingAgentBoard): ScoreMetric[] {
  const delta = b.appsThisWeek - b.appsLastWeek;
  return [
    {
      key: "appsWk", value: String(b.appsThisWeek), tint: TINT.blue,
      labelKey: "leasing.agents.mThisWeek",
      captionKey: "leasing.agents.mThisWeekCaption",
      captionParams: { delta: delta >= 0 ? `+${delta}` : String(delta) },
    },
    { key: "appsLast", value: String(b.appsLastWeek), labelKey: "leasing.agents.mLastWeek" },
    { key: "appsMonth", value: String(b.appsThisMonth), tint: TINT.blue, labelKey: "leasing.agents.mThisMonth" },
    {
      key: "moveIns", value: String(b.moveIns90), tint: TINT.green,
      labelKey: "leasing.agents.mMoveIns",
      captionKey: "leasing.agents.mMoveInsCaption",
      captionParams: { pct: b.conversionPct === null ? "—" : `${Math.round(b.conversionPct)}%`, apps: b.apps90 },
    },
    {
      key: "median", value: b.medianAppToKeysDays === null ? "—" : `${b.medianAppToKeysDays}d`, tint: TINT.amber,
      labelKey: "leasing.agents.mMedian",
      captionKey: "leasing.agents.mMedianCaption",
    },
  ];
}
