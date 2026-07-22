/**
 * Pure lease-span math for the one-shot snapshot backfill ("Honest backfill",
 * per the approved Trends design): daily occupancy CAN be reconstructed from
 * resman_leases start/end spans, so that series is full-depth on day one.
 * Nothing else can — balances, work orders and utility dues have no history —
 * so the backfill writes ONLY the occupancy-family columns and every other
 * metric stays null (which the charts render as "series not yet begun").
 *
 * DATE-PAIR PRECEDENCE (matches what the lease mirror actually populates and
 * how the manager app treats residency, apps/manager/lib/derived/leasing.ts):
 *
 *  - A residency BEGINS on `move_in_date ?? start_date`. The mirror always
 *    carries start_date; move_in_date is the day the unit actually stopped
 *    being vacant, so it wins when present.
 *  - A residency ENDS on `move_out_date ?? (is_current_lease ? null :
 *    end_date)`. move_out_date is the real vacate; a non-current lease
 *    without one falls back to its scheduled end_date; a current lease
 *    without one is open-ended (still occupied today).
 *  - Denied/cancelled leases (status or approval status, the app's
 *    `isDeadLease` rule) never occupied the unit and are skipped.
 *  - Overlapping leases on one unit count ONCE per day: spans are keyed by
 *    unit (resman_unit_id, falling back to unit_number) and merged before
 *    counting.
 */

const DAY_MS = 86_400_000;

/** The resman_leases columns the backfill consumes. */
export interface LeaseSpanRow {
  resman_unit_id: string | null;
  unit_number: string | null;
  status: string | null;
  approval_status: string | null;
  start_date: string | null;
  end_date: string | null;
  move_in_date: string | null;
  move_out_date: string | null;
  is_current_lease: boolean | null;
}

/** The occupancy-family backfill row (snake_case, DB-ready). */
export interface BackfillSnapshotRow {
  snapshot_date: string;
  total_units: number;
  occupied_units: number;
  vacant_units: number;
  occupancy_pct: number | null;
  source: "backfill";
}

/** Same substring rule as the app's `isDeniedStatus`/`isDeadLease`. */
function isDeadLease(lease: Pick<LeaseSpanRow, "status" | "approval_status">): boolean {
  const dead = (s: string | null) => {
    const sl = (s ?? "").toLowerCase();
    return sl.includes("denied") || sl.includes("cancel");
  };
  return dead(lease.status) || dead(lease.approval_status);
}

/** "YYYY-MM-DD" → UTC day index (days since epoch), or null. */
function dayIndex(iso: string | null): number | null {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : null;
}

/** UTC day index → "YYYY-MM-DD". */
function isoOfDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** The [startDay, endDay] occupancy span of one lease, or null when it never
 *  occupied (dead lease / no usable start). endDay is null when open-ended. */
export function leaseOccupancySpan(
  lease: LeaseSpanRow,
): { unitKey: string; startDay: number; endDay: number | null } | null {
  if (isDeadLease(lease)) return null;
  const unitKey = (lease.resman_unit_id ?? "").trim() || (lease.unit_number ?? "").trim();
  if (!unitKey) return null;
  const startDay = dayIndex(lease.move_in_date) ?? dayIndex(lease.start_date);
  if (startDay === null) return null;
  const endDay =
    dayIndex(lease.move_out_date) ??
    (lease.is_current_lease === true ? null : dayIndex(lease.end_date));
  if (endDay !== null && endDay < startDay) return null; // corrupt span
  return { unitKey, startDay, endDay };
}

/**
 * Reconstruct daily occupancy for every day in [fromDate, toDate] inclusive.
 * A unit is occupied on day D when ANY of its leases has span start ≤ D and
 * (open-ended or span end ≥ D). `totalUnits` is today's counted-unit total —
 * the unit inventory of a fixed property is stable, and the mirror has no
 * unit-count history, so the denominator is a documented constant.
 */
export function buildOccupancyBackfill(input: {
  leases: LeaseSpanRow[];
  fromDate: string;
  toDate: string;
  totalUnits: number;
}): BackfillSnapshotRow[] {
  const from = dayIndex(input.fromDate);
  const to = dayIndex(input.toDate);
  if (from === null || to === null || to < from) return [];
  const days = to - from + 1;

  // Per-unit merged day intervals, clamped to the window.
  const byUnit = new Map<string, Array<[number, number]>>();
  for (const lease of input.leases) {
    const span = leaseOccupancySpan(lease);
    if (!span) continue;
    const start = Math.max(span.startDay, from);
    const end = Math.min(span.endDay ?? to, to);
    if (end < start) continue; // outside the window
    const list = byUnit.get(span.unitKey);
    if (list) list.push([start, end]);
    else byUnit.set(span.unitKey, [[start, end]]);
  }

  // Difference array over the day line; each unit contributes at most +1/day
  // because its intervals are merged first (overlapping leases count once).
  const delta = new Array<number>(days + 1).fill(0);
  for (const intervals of byUnit.values()) {
    intervals.sort((a, b) => a[0] - b[0]);
    let [curStart, curEnd] = intervals[0];
    const apply = (s: number, e: number) => {
      delta[s - from] += 1;
      delta[e - from + 1] -= 1;
    };
    for (let i = 1; i < intervals.length; i++) {
      const [s, e] = intervals[i];
      if (s <= curEnd + 1) curEnd = Math.max(curEnd, e);
      else {
        apply(curStart, curEnd);
        [curStart, curEnd] = [s, e];
      }
    }
    apply(curStart, curEnd);
  }

  const rows: BackfillSnapshotRow[] = [];
  let occupied = 0;
  for (let i = 0; i < days; i++) {
    occupied += delta[i];
    // The lease mirror can name units the unit mirror no longer carries;
    // never report more occupied than total.
    const cappedOccupied = Math.min(occupied, input.totalUnits);
    rows.push({
      snapshot_date: isoOfDay(from + i),
      total_units: input.totalUnits,
      occupied_units: cappedOccupied,
      vacant_units: Math.max(0, input.totalUnits - cappedOccupied),
      occupancy_pct:
        input.totalUnits > 0
          ? Math.round((cappedOccupied / input.totalUnits) * 10000) / 100
          : null,
      source: "backfill",
    });
  }
  return rows;
}
