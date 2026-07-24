/**
 * Time and parts against a work order.
 *
 * Held locally for now: ResMan has no field for either until we implement
 * submitting closed work orders to it, so a closed job's record is KEPT rather
 * than pruned — it is evidence waiting for a pipe, not scratch state.
 *
 * Pure on purpose. The store persists; this decides what the numbers mean.
 */

export interface JobPart {
  id: string;
  name: string;
  quantity: number;
}

export interface JobTimeEntry {
  workOrderId: string;
  /** Milliseconds banked by runs that have already stopped. */
  accumulatedMs: number;
  /** Epoch ms the current run started, or null when paused/stopped. */
  runningSince: number | null;
  parts: JobPart[];
  /** Stamped when the work order closed; the entry survives for submission. */
  closedAt: number | null;
}

export function emptyEntry(workOrderId: string): JobTimeEntry {
  return { workOrderId, accumulatedMs: 0, runningSince: null, parts: [], closedAt: null };
}

export function isRunning(entry: JobTimeEntry | undefined): boolean {
  return entry?.runningSince !== null && entry?.runningSince !== undefined;
}

/**
 * Total elapsed, including the run in flight.
 *
 * Clamped at zero per-run: a device clock that moves backwards (timezone change,
 * NTP correction, a tech setting the clock) would otherwise subtract time from a
 * job, and a timer that runs backwards is worse than one that briefly stalls.
 */
export function elapsedMs(entry: JobTimeEntry | undefined, nowMs: number): number {
  if (!entry) return 0;
  const banked = Math.max(0, entry.accumulatedMs);
  if (entry.runningSince === null) return banked;
  return banked + Math.max(0, nowMs - entry.runningSince);
}

/** "00:42:15" — the running display, always H:MM:SS so it doesn't reflow. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * "42m" / "1h 12m" — the summary form, for the close button and the record.
 * Rounds to the nearest minute, but never reports a worked job as "0m".
 */
export function formatShortDuration(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / 60_000);
  if (minutes < 1) return ms > 0 ? "<1m" : "0m";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Total items across the parts list (quantities, not line count). */
export function partsCount(entry: JobTimeEntry | undefined): number {
  return (entry?.parts ?? []).reduce((sum, p) => sum + Math.max(0, p.quantity), 0);
}

/**
 * A one-line human record of the job, appended to the completion notes so the
 * office can see labour and parts today — before any ResMan field exists to
 * carry them. Empty when there is nothing to report, so a close that tracked
 * neither is left untouched.
 */
export function jobSummaryLine(entry: JobTimeEntry | undefined, nowMs: number): string {
  if (!entry) return "";
  const ms = elapsedMs(entry, nowMs);
  const parts = (entry.parts ?? []).filter((p) => p.name.trim().length > 0 && p.quantity > 0);
  if (ms <= 0 && parts.length === 0) return "";

  const bits: string[] = [];
  if (ms > 0) bits.push(`Time on job: ${formatShortDuration(ms)}`);
  if (parts.length > 0) {
    bits.push(`Parts: ${parts.map((p) => `${p.name.trim()} ×${p.quantity}`).join(", ")}`);
  }
  return bits.join(" · ");
}
