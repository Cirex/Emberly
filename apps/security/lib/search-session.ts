/**
 * When a tenant-search counts as a NEW lookup.
 *
 * `unit_lookup_performed` used to fire on one condition only: the search box
 * going empty → non-empty. That undercounts badly, because the box is rarely
 * cleared. A guard who types over the previous unit all shift — select-all,
 * type, read, select-all, type — registers ONE event for the whole shift, and
 * the metric reads as engagement rather than lookups.
 *
 * So a session also ends when the guard stops typing for a while. Two cars,
 * two minutes apart, are two lookups whether or not the box was cleared in
 * between.
 *
 * NO TIMER, deliberately. A `setTimeout` would be the obvious way to express
 * "idle for N seconds", but React Native throttles and suspends timers while
 * the app is backgrounded — exactly the gap we most want to count as a session
 * break. Comparing timestamps on the next keystroke is immune to that: however
 * long the phone was asleep, the arithmetic is the same when it wakes.
 */

/**
 * How long the box may sit untouched before the next keystroke opens a new
 * session.
 *
 * Two minutes is a judgement call, tuned to the gate: long enough that a guard
 * reading a result, talking to a driver, then refining the SAME search is not
 * double-counted; short enough that the next car is its own lookup. Capture
 * carries `after_idle` so the split between the two reset paths is measurable —
 * check it before moving this number.
 */
export const SEARCH_SESSION_IDLE_MS = 120_000;

export interface SearchSessionState {
  /** Whether the box held a non-blank query at the last evaluation. */
  active: boolean;
  /** Timestamp of the last non-blank input. 0 before any. */
  lastInputAt: number;
}

export const EMPTY_SEARCH_SESSION: SearchSessionState = { active: false, lastInputAt: 0 };

export interface SearchSessionStep {
  /** Fire `unit_lookup_performed` for this input. */
  started: boolean;
  /** True when the session opened because the box went idle rather than empty. */
  afterIdle: boolean;
  next: SearchSessionState;
}

/**
 * Fold one input event into the session.
 *
 * Blank counts as empty — `"   "` ends a session exactly as `""` does, so a
 * lingering space cannot hold one open. Clearing the box (ⓧ or backspace) and
 * going idle are the two ways a session ends; they are equivalent here, and
 * only `afterIdle` distinguishes them for reporting.
 */
export function advanceSearchSession(
  prev: SearchSessionState,
  rawQuery: string,
  nowMs: number,
  idleMs: number = SEARCH_SESSION_IDLE_MS,
): SearchSessionStep {
  const hasQuery = rawQuery.trim().length > 0;

  if (!hasQuery) {
    // Session over. `lastInputAt` is kept rather than zeroed: it is only ever
    // read alongside `active`, and preserving it keeps this a pure fold.
    return {
      started: false,
      afterIdle: false,
      next: { active: false, lastInputAt: prev.lastInputAt },
    };
  }

  const afterIdle = prev.active && nowMs - prev.lastInputAt >= idleMs;
  return {
    started: !prev.active || afterIdle,
    afterIdle,
    next: { active: true, lastInputAt: nowMs },
  };
}
