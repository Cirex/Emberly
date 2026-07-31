/**
 * Per-entity outlier detection over a time series.
 *
 * `aggregate_resource` with a `period` answers "what did the property spend by
 * month". This answers the follow-up that actually drives work: "WHICH accounts
 * moved, and by how much against their own normal". A property-level total hides
 * exactly the case worth acting on — one unit's water usage tripling while the
 * portfolio total barely twitches.
 *
 * Each entity is scored against ITS OWN history, never against the population.
 * A large account and a small one have different normals, and a shared baseline
 * would flag every large account forever.
 *
 * Deliberately simple statistics. This is a triage tool that ranks candidates
 * for a human to look at, not an inference engine — so it reports the inputs
 * (baseline mean, spread, how many periods it had) alongside every score, and
 * says which method produced the score.
 */

import { keyForValue, type PeriodColumnKind, type PeriodInterval } from "./period-buckets";

/** Baseline periods an entity needs before it can be scored at all. */
export const MIN_BASELINE_PERIODS = 3;

/**
 * Spread below which a z-score stops being meaningful.
 *
 * An entity billed exactly 40.00 four months running has a standard deviation
 * of zero, so any change at all divides by ~0 and scores infinite. That is a
 * true observation ("this has never varied") but a useless ranking, so those
 * fall back to percent change and say so.
 */
const FLAT_EPSILON = 1e-9;

export interface AnomalyInput {
  entity: string;
  period: string;
  value: number;
}

export interface Anomaly {
  entity: string;
  period: string;
  value: number;
  baseline_mean: number;
  baseline_stddev: number;
  baseline_periods: number;
  /** Standard deviations from the entity's own mean. Null when it had no spread. */
  z: number | null;
  /** Change against the baseline mean, as a percentage. Null when the mean is 0. */
  pct_change: number | null;
  direction: "up" | "down";
  /** Which statistic ranked this row — z-score, or percent change as fallback. */
  method: "zscore" | "pct_change";
}

export interface AnomalyReport {
  /** The period every entity was scored on. */
  focus_period: string;
  entities_considered: number;
  entities_scored: number;
  anomalies: Anomaly[];
  notes: string[];
}

/**
 * Fold raw (entity, period, value) rows into per-entity series, then score the
 * most recent period against each entity's own history.
 *
 * `focusPeriod` defaults to the latest period present anywhere in the data,
 * rather than each entity's own latest: an account that stopped reporting three
 * months ago should not have its stale final month judged as if it were current.
 */
export function detectAnomalies(
  rows: readonly AnomalyInput[],
  opts: { limit?: number; minBaseline?: number; focusPeriod?: string } = {},
): AnomalyReport {
  const limit = opts.limit ?? 20;
  const minBaseline = opts.minBaseline ?? MIN_BASELINE_PERIODS;

  const series = new Map<string, Map<string, number>>();
  for (const row of rows) {
    let byPeriod = series.get(row.entity);
    if (!byPeriod) {
      byPeriod = new Map();
      series.set(row.entity, byPeriod);
    }
    byPeriod.set(row.period, (byPeriod.get(row.period) ?? 0) + row.value);
  }

  const focus = opts.focusPeriod ?? [...new Set(rows.map((r) => r.period))].sort().pop() ?? "";
  const notes: string[] = [];
  const anomalies: Anomaly[] = [];
  let scored = 0;

  for (const [entity, byPeriod] of series) {
    const current = byPeriod.get(focus);
    // No row in the focus period. That may itself be interesting, but "absent"
    // and "zero" are different claims and this tool will not conflate them.
    if (current === undefined) continue;

    const baseline = [...byPeriod.entries()].filter(([p]) => p !== focus).map(([, v]) => v);
    if (baseline.length < minBaseline) continue;
    scored += 1;

    const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
    const variance = baseline.reduce((a, b) => a + (b - mean) ** 2, 0) / baseline.length;
    const stddev = Math.sqrt(variance);
    const pct = mean === 0 ? null : ((current - mean) / Math.abs(mean)) * 100;
    const usable = stddev > FLAT_EPSILON;

    anomalies.push({
      entity,
      period: focus,
      value: current,
      baseline_mean: mean,
      baseline_stddev: stddev,
      baseline_periods: baseline.length,
      z: usable ? (current - mean) / stddev : null,
      pct_change: pct,
      direction: current >= mean ? "up" : "down",
      method: usable ? "zscore" : "pct_change",
    });
  }

  // Rank by whichever statistic each row could produce. A flat-history entity
  // is ranked on percent change so it is not silently dropped, but its `method`
  // records that the two are not the same measurement.
  const rank = (a: Anomaly) => (a.z !== null ? Math.abs(a.z) : Math.abs(a.pct_change ?? 0) / 100);
  anomalies.sort((a, b) => rank(b) - rank(a));

  if (series.size === 0) {
    // Every row was dropped for want of an entity, a date or a value. Saying
    // "no anomalies" here would report a clean bill of health for a column that
    // is simply empty — MLGW publishes no water readings on these accounts, and
    // "no water anomalies" is a very different claim from "no water data".
    notes.push(
      "No usable rows: every row was missing the entity, the date or the measure. This is NOT 'no anomalies' — there was nothing to score. Check that the measure is populated at all.",
    );
  } else if (scored === 0) {
    notes.push(
      `No entity had ${minBaseline} prior periods plus a value in ${focus}, so nothing could be scored. Widen the range or use a coarser interval.`,
    );
  }
  notes.push(
    `Scored against each entity's OWN history, not against other entities. A high z means unusual FOR THIS ENTITY.`,
  );

  return {
    focus_period: focus,
    entities_considered: series.size,
    entities_scored: scored,
    anomalies: anomalies.slice(0, limit),
    notes,
  };
}

/**
 * Project raw database rows onto the (entity, period, value) triples the
 * detector consumes. Rows with a null entity, an unparseable date or a null
 * measure are dropped — same null discipline as the aggregates.
 */
export function toAnomalyInputs(
  rows: readonly Record<string, unknown>[],
  spec: {
    entityColumn: string;
    periodColumn: string;
    measure: string;
    interval: PeriodInterval;
    kind: PeriodColumnKind;
    timezone: string;
  },
): AnomalyInput[] {
  const out: AnomalyInput[] = [];
  for (const row of rows) {
    const entity = row[spec.entityColumn];
    if (entity === null || entity === undefined || entity === "") continue;
    const rawDate = row[spec.periodColumn];
    if (rawDate === null || rawDate === undefined || rawDate === "") continue;
    const period = keyForValue(String(rawDate), spec.interval, spec.kind, spec.timezone);
    if (!period) continue;
    const rawValue = row[spec.measure];
    if (rawValue === null || rawValue === undefined || rawValue === "") continue;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    out.push({ entity: String(entity), period, value });
  }
  return out;
}
