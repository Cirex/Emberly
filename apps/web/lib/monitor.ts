/**
 * The scheduled monitor — turns the MCP's pull tools into push.
 *
 * `detect_anomalies` and `data_freshness` are excellent and nobody was going to
 * run them. Run once by hand they found a utility bill at 606.74 against a
 * 40.39 baseline that had been sitting a month, and six mirror tables eleven
 * days stale. Both are the kind of thing you want to be told, not the kind you
 * remember to check.
 *
 * Findings are FINGERPRINTED (kind|resource|entity|period), so a finding that
 * persists for a week is one row with a moving last_seen_at rather than seven
 * rows; and a finding that stops recurring is stamped resolved_at rather than
 * left looking current. Those two properties are the difference between a
 * monitoring table people read and one they learn to ignore.
 */

import { detectAnomalies, toAnomalyInputs, type Anomaly } from "./anomalies";
import { DEFAULT_TIMEZONE, type PeriodInterval } from "./period-buckets";
import { scanForSeries } from "./resman-api";
import { RESMAN_RESOURCES, type ResmanResource } from "./resman-resources";
import type { UntypedSupabase } from "./supabase/types";

/** Lag behind the freshest resource, in hours, that counts as stale. */
const STALE_AFTER_HOURS = 24;

/**
 * |z| at which an anomaly is critical rather than merely worth a look.
 *
 * Not a statistical claim — with a handful of baseline periods a z of 6 is not
 * a p-value, it is a ranking. It is set where the live data put the genuinely
 * interesting cases and nothing else.
 */
const CRITICAL_Z = 6;
const WARN_Z = 3;

/** A series worth watching every night. */
interface AnomalyWatch {
  resource: string;
  entity: string;
  measure: string;
  periodColumn: string;
  interval: PeriodInterval;
}

/**
 * What the monitor watches. Deliberately a short, explicit list rather than
 * "every measure on every resource" — a monitor that reports everything reports
 * nothing, and each entry here should be something someone would act on.
 */
export const ANOMALY_WATCHES: readonly AnomalyWatch[] = [
  // The one that found the 606.74 bill.
  { resource: "mlgw/bills", entity: "mlgw_account_id", measure: "amount_due", periodColumn: "bill_date", interval: "month" },
  // Consumption moves before spend does when a leak starts.
  { resource: "mlgw/bills", entity: "mlgw_account_id", measure: "electric_usage", periodColumn: "bill_date", interval: "month" },
  { resource: "mlgw/bills", entity: "mlgw_account_id", measure: "gas_usage", periodColumn: "bill_date", interval: "month" },
  // Needs a few days of unit_snapshots before it can score anything, and says
  // so rather than reporting a clean bill of health in the meantime.
  { resource: "unit-snapshots", entity: "resman_unit_id", measure: "balance", periodColumn: "snapshot_date", interval: "week" },
];

export interface Finding {
  fingerprint: string;
  kind: "anomaly" | "staleness";
  severity: "info" | "warn" | "critical";
  resource: string;
  entity: string | null;
  period: string | null;
  summary: string;
  detail: Record<string, unknown>;
}

export interface MonitorResult {
  findings: Finding[];
  opened: number;
  updated: number;
  resolved: number;
  notes: string[];
}

function severityForAnomaly(anomaly: Anomaly): "info" | "warn" | "critical" {
  const magnitude = anomaly.z !== null ? Math.abs(anomaly.z) : Math.abs(anomaly.pct_change ?? 0) / 100;
  if (magnitude >= CRITICAL_Z) return "critical";
  if (magnitude >= WARN_Z) return "warn";
  return "info";
}

const byName = (name: string): ResmanResource | undefined =>
  RESMAN_RESOURCES.find((r) => r.name === name);

/** Run every anomaly watch and turn the outliers into findings. */
export async function collectAnomalyFindings(
  client: UntypedSupabase,
  notes: string[],
): Promise<Finding[]> {
  const findings: Finding[] = [];

  for (const watch of ANOMALY_WATCHES) {
    const resource = byName(watch.resource);
    if (!resource) continue;
    const period = resource.periods[watch.periodColumn];
    if (!period) {
      notes.push(`watch skipped: ${watch.resource} has no period column ${watch.periodColumn}`);
      continue;
    }

    const { rows, truncated } = await scanForSeries(
      resource,
      new URLSearchParams(),
      [watch.entity, period.column, watch.measure],
      client,
    );
    const report = detectAnomalies(
      toAnomalyInputs(rows, {
        entityColumn: watch.entity,
        periodColumn: period.column,
        measure: watch.measure,
        interval: watch.interval,
        kind: period.kind,
        timezone: DEFAULT_TIMEZONE,
      }),
      { limit: 25 },
    );
    if (truncated) {
      notes.push(`${watch.resource}.${watch.measure}: scan hit its cap, baselines may be partial`);
    }
    if (report.entities_scored === 0) {
      // Not a finding. Saying nothing here is right, but it must not be
      // mistaken for "checked, all clear" — the note carries the difference.
      notes.push(`${watch.resource}.${watch.measure}: nothing scoreable (${report.notes[0] ?? "no history"})`);
      continue;
    }

    for (const anomaly of report.anomalies) {
      const severity = severityForAnomaly(anomaly);
      // Only escalations are worth a row. An `info` finding on every account
      // that moved a little is exactly the noise that kills a monitor.
      if (severity === "info") continue;
      const direction = anomaly.direction === "up" ? "rose" : "fell";
      findings.push({
        fingerprint: `anomaly|${watch.resource}|${anomaly.entity}|${anomaly.period}|${watch.measure}`,
        kind: "anomaly",
        severity,
        resource: watch.resource,
        entity: anomaly.entity,
        period: anomaly.period,
        summary:
          `${watch.measure} ${direction} to ${anomaly.value} in ${anomaly.period}, against a baseline of ` +
          `${anomaly.baseline_mean.toFixed(2)} over ${anomaly.baseline_periods} periods` +
          (anomaly.pct_change === null ? "" : ` (${anomaly.pct_change.toFixed(0)}%)`),
        detail: { ...anomaly, measure: watch.measure, interval: watch.interval },
      });
    }
  }
  return findings;
}

/** Flag resources lagging materially behind the freshest one. */
export async function collectStalenessFindings(
  client: UntypedSupabase,
  notes: string[],
): Promise<Finding[]> {
  // Only SYNC-BACKED resources are candidates. `synced_at` exists precisely on
  // the tables a scraper maintains, so its absence marks a table written by
  // user activity instead — guest passes, entry logs, the snapshot jobs. Those
  // being quiet is not a failure, and judging them produced exactly that false
  // positive: guest-passes flagged at 340h behind when it simply had not had a
  // new pass issued.
  const synced = RESMAN_RESOURCES.filter((r) => r.selectColumns.includes("synced_at"));
  const rows = await Promise.all(
    synced.map(async (resource) => {
      const { data } = await client
        .from(resource.table).select("synced_at").not("synced_at", "is", null)
        .order("synced_at", { ascending: false }).limit(1);
      const value = (data as Record<string, unknown>[] | null)?.[0]?.synced_at;
      return { resource, at: value === null || value === undefined ? null : String(value) };
    }),
  );

  // Staleness is RELATIVE, not against a wall clock: an absolute threshold
  // flags the whole mirror after a quiet weekend, while a table that stopped
  // syncing while its neighbours kept going is the actual failure — which is
  // how `units` sat frozen for eleven days unnoticed.
  //
  // The reference is the MEDIAN, not the maximum. Against the maximum a single
  // unusually-recent table drags everything else over the threshold at once —
  // observed live the moment unit_snapshots was created, which instantly made
  // eight healthy resources look 28h stale. The median moves only when half the
  // mirror moves, so one table out of step is visible and one table ahead is not
  // an alarm.
  const stamps = rows.map((r) => (r.at ? Date.parse(r.at) : NaN)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  if (stamps.length === 0) {
    notes.push("no sync-backed resource reported a synced_at; staleness not evaluated");
    return [];
  }
  const reference = stamps[Math.floor(stamps.length / 2)];

  const findings: Finding[] = [];
  for (const { resource, at } of rows) {
    if (!at) continue;
    const lagHours = (reference - Date.parse(at)) / 3_600_000;
    if (lagHours <= STALE_AFTER_HOURS) continue;
    findings.push({
      fingerprint: `staleness|${resource.name}`,
      kind: "staleness",
      severity: lagHours > STALE_AFTER_HOURS * 7 ? "critical" : "warn",
      resource: resource.name,
      entity: null,
      period: null,
      summary: `${resource.name} last synced ${Math.round(lagHours)}h behind the rest of the mirror (${at})`,
      detail: {
        lag_hours: Math.round(lagHours * 10) / 10,
        synced_at: at,
        reference_at: new Date(reference).toISOString(),
        reference: "median synced_at across sync-backed resources",
      },
    });
  }
  return findings;
}

/**
 * Run every monitor and reconcile the results against what is already open.
 *
 * Persistence is the whole point: upsert on fingerprint so a recurring finding
 * updates, and resolve anything previously open that this run did not produce.
 */
export async function runMonitor(client: UntypedSupabase): Promise<MonitorResult> {
  const notes: string[] = [];
  const findings = [
    ...(await collectAnomalyFindings(client, notes)),
    ...(await collectStalenessFindings(client, notes)),
  ];

  const now = new Date().toISOString();
  const { data: existingRows } = await client
    .from("monitor_findings")
    .select("fingerprint, resolved_at, notified_at")
    .limit(2000);
  const existing = new Map(
    ((existingRows ?? []) as { fingerprint: string; resolved_at: string | null; notified_at: string | null }[])
      .map((r) => [r.fingerprint, r]),
  );

  let opened = 0;
  let updated = 0;
  for (const finding of findings) {
    const prior = existing.get(finding.fingerprint);
    if (prior && prior.resolved_at === null) updated += 1;
    else opened += 1;
    const { error } = await client.from("monitor_findings").upsert(
      {
        fingerprint: finding.fingerprint,
        kind: finding.kind,
        severity: finding.severity,
        resource: finding.resource,
        entity: finding.entity,
        period: finding.period,
        summary: finding.summary,
        detail: finding.detail,
        last_seen_at: now,
        // A finding that comes back after resolving is open again, not a new
        // row — the fingerprint is its identity.
        resolved_at: null,
        // A problem RETURNING is news again, so clear the announcement stamp
        // on recurrence. A finding that merely persists keeps its stamp and is
        // therefore not re-announced.
        ...(prior && prior.resolved_at !== null ? { notified_at: null } : {}),
      },
      { onConflict: "fingerprint" },
    );
    if (error) notes.push(`upsert failed for ${finding.fingerprint}: ${error.message}`);
  }

  // Resolve what this run did NOT produce, so a fixed problem stops looking
  // like a live one.
  const seen = new Set(findings.map((f) => f.fingerprint));
  const toResolve = [...existing.entries()]
    .filter(([fingerprint, row]) => row.resolved_at === null && !seen.has(fingerprint))
    .map(([fingerprint]) => fingerprint);
  if (toResolve.length > 0) {
    await client.from("monitor_findings").update({ resolved_at: now }).in("fingerprint", toResolve);
  }

  return { findings, opened, updated, resolved: toResolve.length, notes };
}
