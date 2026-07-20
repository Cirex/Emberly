import type { ParsedWorkOrder } from "./types";

/**
 * The My Day path engine — pure functions only (fixture-tested in
 * tests/my-path.test.ts). Decides which of a technician's open work orders
 * deserve a spot on their daily path, per the approved 2026-07-19 spec:
 *
 *   1. Emergencies always win — priority "Emergency" pins to the TOP of the
 *      path the moment it appears, even when unassigned.
 *   2. Everything else gets a WEIGHTED VALUE SCORE (`scoreUnit`): ResMan
 *      priority base + urgent-trade bonus (water › HVAC › electrical) + a
 *      small callback bump + a multi-ticket stacking bonus + an ACCELERATING
 *      age bonus — so a Normal with no key tag sits low until it's genuinely
 *      old (~2 months), then climbs.
 *   3. The daily path is built by a PROXIMITY-AWARE greedy walk
 *      (`buildPath`): from each position the next stop maximizes
 *      `score − travelWeight × normalizedDistance`, so nearby clusters win and
 *      a big score gap still justifies a long walk.
 *   4. One stop per unit — a unit's open work orders share a stop.
 *
 * `rankUnits` (the older strict-tier sort) is retained for grouping
 * emergencies, where the score/route don't apply.
 */

export type UrgentTrade = "hvac" | "leak" | "clog" | "electrical";

function wordsOf(text: string): Set<string> {
  return new Set(text.split(/[^a-z0-9]+/).filter((w) => w.length > 0));
}

/** Which urgent trade a work order belongs to, if any. Tags + title. */
export function urgentTrade(wo: ParsedWorkOrder): UrgentTrade | null {
  const hay = `${wo.tags.join(" ")} ${wo.title}`.toLowerCase();
  const words = wordsOf(hay);
  const has = (w: string) => words.has(w);

  // A row the tag engine reclassified as dried/past Water Damage (not an active
  // Leak) is remediation, not an urgent water job — don't let its title's
  // "leak" wording re-promote it. Kept in sync with deriveWorkOrderTags'
  // "active wins, past → Water Damage" split.
  const tagSet = new Set(wo.tags.map((t) => t.trim().toLowerCase()));
  const isWaterDamageOnly = tagSet.has("water damage") && !tagSet.has("leaks");

  if (
    hay.includes("hvac") ||
    has("ac") ||
    has("a/c") ||
    hay.includes("air condition") ||
    hay.includes("not cooling") ||
    hay.includes("no heat") ||
    has("furnace") ||
    has("thermostat") ||
    has("heat") ||
    has("heating") ||
    has("cooling")
  ) {
    return "hvac";
  }
  if (
    !isWaterDamageOnly &&
    (has("leak") || has("leaking") || has("leaks") || hay.includes("plumb") || has("drip") || has("dripping"))
  ) {
    return "leak";
  }
  if (has("clog") || has("clogged") || has("clogs") || has("drain") || hay.includes("backed up") || has("backup")) {
    return "clog";
  }
  if (hay.includes("electric") || has("outlet") || has("outlets") || has("breaker") || hay.includes("no power") || has("power")) {
    return "electrical";
  }
  return null;
}

/** Emergency › High/Urgent › Normal › Low, string-tolerant. */
export function priorityRank(priority: string): number {
  const p = priority.toLowerCase();
  if (p.includes("emergency")) return 0;
  if (p.includes("high") || p.includes("urgent")) return 1;
  if (p.includes("low")) return 3;
  return 2; // Normal and anything unrecognized
}

export function isEmergency(wo: ParsedWorkOrder): boolean {
  return priorityRank(wo.priority) === 0;
}

/** Case/space-insensitive match of the signed-in staff name to a row's tech. */
export function techMatches(staffName: string, wo: ParsedWorkOrder): boolean {
  const a = staffName.trim().toLowerCase();
  if (a.length === 0) return false;
  return wo.technicianDisplay.trim().toLowerCase() === a;
}

export interface UnitCandidate {
  unitNumber: string;
  /** All qualifying open work orders in the unit, best-scoring first. */
  workOrders: ParsedWorkOrder[];
  trade: UrgentTrade | null;
  bestPriorityRank: number;
  oldestReportedAt: number;
}

/** Sort key for individual work orders inside a unit (best first). */
function compareWork(a: ParsedWorkOrder, b: ParsedWorkOrder): number {
  const trade = Number(urgentTrade(b) !== null) - Number(urgentTrade(a) !== null);
  if (trade !== 0) return trade;
  const pri = priorityRank(a.priority) - priorityRank(b.priority);
  if (pri !== 0) return pri;
  return (a.reportedAt ?? Infinity) - (b.reportedAt ?? Infinity);
}

/**
 * Group a pool of work orders into per-unit candidates (one stop per unit),
 * each unit's work orders sorted best-first. No ranking between units — the
 * caller scores/sorts. The pool should already be filtered to what qualifies.
 */
export function unitCandidatesOf(pool: ParsedWorkOrder[]): UnitCandidate[] {
  const byUnit = new Map<string, ParsedWorkOrder[]>();
  for (const wo of pool) {
    const unit = wo.unitNumber.trim();
    if (unit.length === 0) continue;
    const bucket = byUnit.get(unit);
    if (bucket) bucket.push(wo);
    else byUnit.set(unit, [wo]);
  }

  const candidates: UnitCandidate[] = [];
  for (const [unitNumber, workOrders] of byUnit) {
    workOrders.sort(compareWork);
    const trades = workOrders.map(urgentTrade).filter((t): t is UrgentTrade => t !== null);
    candidates.push({
      unitNumber,
      workOrders,
      trade: trades[0] ?? null,
      bestPriorityRank: Math.min(...workOrders.map((wo) => priorityRank(wo.priority))),
      oldestReportedAt: Math.min(...workOrders.map((wo) => wo.reportedAt ?? Infinity)),
    });
  }
  return candidates;
}

/**
 * Group a pool into unit candidates, ranked by the legacy strict-tier rule
 * (emergency › any-trade › priority › age). Still used to group emergencies,
 * which pin to the top regardless of the weighted score.
 */
export function rankUnits(pool: ParsedWorkOrder[]): UnitCandidate[] {
  const candidates = unitCandidatesOf(pool);

  candidates.sort((a, b) => {
    const emergency = Number(b.bestPriorityRank === 0) - Number(a.bestPriorityRank === 0);
    if (emergency !== 0) return emergency;
    const trade = Number(b.trade !== null) - Number(a.trade !== null);
    if (trade !== 0) return trade;
    const pri = a.bestPriorityRank - b.bestPriorityRank;
    if (pri !== 0) return pri;
    const age = a.oldestReportedAt - b.oldestReportedAt;
    if (age !== 0) return age;
    return a.unitNumber.localeCompare(b.unitNumber);
  });
  return candidates;
}

// ---------------------------------------------------------------------------
// Weighted value score + proximity-aware routing (approved 2026-07-19).
// ---------------------------------------------------------------------------

/** ResMan priority → base points. Emergencies are pinned separately, above. */
const PRIORITY_BASE: Record<number, number> = { 0: 1000, 1: 50, 2: 15, 3: 5 };

/** Urgent-trade bonus: active water (leaks/clogs) outranks HVAC outranks
 *  electrical (the approved ranking). */
export const TRADE_WEIGHT: Record<UrgentTrade, number> = {
  leak: 60,
  clog: 60,
  hvac: 40,
  electrical: 25,
};

/** A re-report (the first fix didn't hold) gets a small nudge. */
const CALLBACK_BUMP = 12;
/** Each extra open ticket in the unit adds a little, capped — a busy unit is
 *  worth one trip more than a single-ticket one. */
const STACK_BONUS = 8;
const STACK_CAP = 3;
/** Age bonus = AGE_COEFF·(daysOpen / AGE_DIVISOR)^AGE_EXP — gentle early, steep
 *  late. Tuned so a Normal-no-tag (base 15) reaches ~HVAC weight near 60 days
 *  and dominates by a few months (the "~2+ months before it climbs" choice). */
const AGE_COEFF = 10;
const AGE_DIVISOR = 30;
const AGE_EXP = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a work order carries a possible/confirmed callback signal. */
function isCallback(wo: ParsedWorkOrder): boolean {
  return wo.callbackStatus === "possible" || wo.callbackStatus === "confirmed";
}

export function ageBonus(oldestReportedAt: number, nowMs: number): number {
  if (!Number.isFinite(oldestReportedAt)) return 0;
  const days = Math.max(0, (nowMs - oldestReportedAt) / DAY_MS);
  return AGE_COEFF * Math.pow(days / AGE_DIVISOR, AGE_EXP);
}

/**
 * The weighted urgency of a unit candidate. Higher = belongs earlier on the
 * path. Emergencies dominate via their base; everything else blends priority,
 * trade, callback, ticket count, and age.
 */
export function scoreUnit(c: UnitCandidate, nowMs: number): number {
  const base = PRIORITY_BASE[c.bestPriorityRank] ?? PRIORITY_BASE[2];
  const trade = c.trade ? TRADE_WEIGHT[c.trade] : 0;
  const callback = c.workOrders.some(isCallback) ? CALLBACK_BUMP : 0;
  const stack = Math.min(Math.max(c.workOrders.length - 1, 0), STACK_CAP) * STACK_BONUS;
  return base + trade + callback + stack + ageBonus(c.oldestReportedAt, nowMs);
}

export interface PathPoint {
  x: number;
  y: number;
}

/** Medium proximity strength — how many score-points a full-property walk
 *  "costs". Clusters of nearby work win; a big score gap (a leak) still
 *  justifies crossing the property. Distance is normalized to the property
 *  diagonal so this is scale-independent. */
export const TRAVEL_WEIGHT_MEDIUM = 30;

interface BuildPathOptions {
  centers: ReadonlyMap<string, PathPoint>;
  nowMs: number;
  size: number;
  travelWeight?: number;
}

/** Diagonal of the bounding box over the given points (0 when <2 points). */
function boundingDiagonal(points: PathPoint[]): number {
  if (points.length < 2) return 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

/**
 * Build the day's path from a pool of a technician's open work orders: score
 * every unit, then greedily walk — seeding with the highest-scoring unit and
 * repeatedly taking the one that maximizes `score − travelWeight ×
 * (distance / diagonal)`. Units with no known centroid still compete on score
 * (distance treated as neutral) and never block the walk. Returns at most
 * `size` unit candidates in walk order.
 */
export function buildPath(pool: ParsedWorkOrder[], opts: BuildPathOptions): UnitCandidate[] {
  const { centers, nowMs, size } = opts;
  const travelWeight = opts.travelWeight ?? TRAVEL_WEIGHT_MEDIUM;
  const candidates = unitCandidatesOf(pool);
  if (candidates.length === 0 || size <= 0) return [];

  const scored = candidates
    .map((c) => ({ c, score: scoreUnit(c, nowMs), center: centers.get(c.unitNumber) }))
    .sort((a, b) => b.score - a.score || a.c.unitNumber.localeCompare(b.c.unitNumber));

  // Property diagonal from the located candidates, for scale-free distance.
  const diagonal = boundingDiagonal(scored.map((s) => s.center).filter((p): p is PathPoint => !!p));
  const distCost = (from: PathPoint | undefined, to: PathPoint | undefined): number => {
    if (!from || !to || diagonal === 0) return 0;
    return travelWeight * (Math.hypot(to.x - from.x, to.y - from.y) / diagonal);
  };

  const remaining = scored.slice();
  const ordered: UnitCandidate[] = [];
  // Seed with the highest-scoring unit — the most urgent job leads the day.
  let current = remaining.shift();
  if (!current) return [];
  ordered.push(current.c);

  while (remaining.length > 0 && ordered.length < size) {
    let bestIdx = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const r = remaining[i];
      const value = r.score - distCost(current.center, r.center);
      if (value > bestValue) {
        bestValue = value;
        bestIdx = i;
      }
    }
    current = remaining.splice(bestIdx, 1)[0];
    ordered.push(current.c);
  }
  return ordered;
}

/** Local calendar-day key for the daily rollover ("2026-07-18"). */
export function dayKeyOf(nowMs: number): string {
  const d = new Date(nowMs);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Good morning / afternoon (noon) / evening (4 PM), per the approved spec. */
export function greetingFor(nowMs: number): string {
  const h = new Date(nowMs).getHours();
  if (h < 12) return "Good morning";
  if (h < 16) return "Good afternoon";
  return "Good evening";
}
