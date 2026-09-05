/**
 * When a tenant-search counts as a NEW lookup.
 *
 * `unit_lookup_performed` originally fired on one condition: the search box
 * going empty → non-empty. The box is rarely cleared, so a guard who works by
 * typing over the previous unit registered ONE event for an entire shift, and
 * the metric read as engagement rather than lookups.
 *
 * A session therefore ends after a period of no typing, reached two ways:
 *
 *   · IDLE — the box sits untouched past `SEARCH_SESSION_IDLE_MS`. Two cars,
 *     a while apart, are two lookups whether or not the box was cleared.
 *   · CLEARED — the box goes blank and STAYS blank past
 *     `SEARCH_SESSION_REOPEN_MS`, currently the same value.
 *
 * That second timeout is not fussiness. Treating a clear as an instant end
 * double-counts the commonest correction there is: type a wrong digit,
 * backspace it, type the right one. The box passes through empty in ~200ms,
 * and without the timeout that single lookup scored as two — measured, not
 * assumed. Requiring the box to stay empty briefly separates "I mistyped"
 * from "I'm done with that unit": a deliberate clear is followed by a glance
 * at the next car, not an instant keystroke.
 *
 * NO setTimeout, deliberately. That is the obvious way to express both
 * thresholds, but React Native throttles and suspends timers while the app is
 * backgrounded — precisely the gap most worth counting as a break. Comparing
 * timestamps on the next keystroke is immune: however long the phone slept,
 * the arithmetic is the same when it wakes.
 */

/**
 * How long the box may sit untouched before the next keystroke opens a new
 * session.
 *
 * 10s is tuned to the gate: a guard moves car to car quickly, and a pause this
 * long means the previous interaction is over. It is deliberately tight, and
 * the cost is real — reading a result for 10s and then refining the SAME
 * search scores twice. `after_idle` on the event is what makes that rate
 * measurable: if it climbs toward most of the traffic, the window is too
 * short and this is the number to raise.
 *
 * History: 120s originally, then 15s, now 10s.
 */
export const SEARCH_SESSION_IDLE_MS = 10_000;

/**
 * How long the box must STAY blank for a clear to end the session. Under this,
 * the blank is treated as mid-edit and the session continues.
 *
 * Held equal to the idle window on purpose, which collapses the whole model to
 * one sentence: A SESSION ENDS AFTER 10s OF NO TYPING. Clearing carries no
 * special meaning — it is just another edit, and backspace-and-retype stays
 * one lookup because the gap is milliseconds, not seconds.
 *
 * The cost of equality, stated plainly: a guard who clears deliberately and
 * types a DIFFERENT unit within 10s is now scored as one lookup, not two.
 * That is a real undercount, traded for immunity to typo-correction
 * over-counting. Drop this to ~1s to recover those at the cost of the trade.
 */
export const SEARCH_SESSION_REOPEN_MS = SEARCH_SESSION_IDLE_MS;

export interface SearchSessionState {
  /** Whether the box held a non-blank query at the last evaluation. */
  active: boolean;
  /** Timestamp of the last non-blank input. 0 before any. */
  lastInputAt: number;
  /** When the box most recently went blank. 0 when it has never been blank. */
  emptiedAt: number;
}

export const EMPTY_SEARCH_SESSION: SearchSessionState = {
  active: false,
  lastInputAt: 0,
  emptiedAt: 0,
};

export interface SearchSessionStep {
  /** Fire `unit_lookup_performed` for this input. */
  started: boolean;
  /** True when the session opened on the idle rule rather than a clear. */
  afterIdle: boolean;
  next: SearchSessionState;
}

/**
 * Fold one input event into the session.
 *
 * Blank counts as empty — `"   "` behaves exactly as `""`, so a lingering space
 * can neither hold a session open nor start one. ⓧ and backspace are
 * indistinguishable here by design: both only drive the value to empty.
 */
export function advanceSearchSession(
  prev: SearchSessionState,
  rawQuery: string,
  nowMs: number,
  idleMs: number = SEARCH_SESSION_IDLE_MS,
  reopenMs: number = SEARCH_SESSION_REOPEN_MS,
): SearchSessionStep {
  const hasQuery = rawQuery.trim().length > 0;

  if (!hasQuery) {
    return {
      started: false,
      afterIdle: false,
      next: {
        active: false,
        lastInputAt: prev.lastInputAt,
        // Stamped only on the TRANSITION into blank. Re-stamping on every
        // blank keystroke would keep pushing the clock forward and hold a
        // cleared session open forever.
        emptiedAt: prev.active ? nowMs : prev.emptiedAt,
      },
    };
  }

  // Typed straight through a long pause, box never cleared.
  const afterIdle = prev.active && nowMs - prev.lastInputAt >= idleMs;
  // Re-opened after a blank that lasted. `emptiedAt === 0` is the first ever
  // input, which is always a new session rather than a resumption.
  const afterClear = !prev.active && (prev.emptiedAt === 0 || nowMs - prev.emptiedAt >= reopenMs);

  return {
    started: afterIdle || afterClear,
    afterIdle,
    next: { active: true, lastInputAt: nowMs, emptiedAt: 0 },
  };
}
