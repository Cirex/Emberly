import { describe, expect, test } from "bun:test";
import {
  EMPTY_SEARCH_SESSION,
  SEARCH_SESSION_IDLE_MS,
  advanceSearchSession,
  type SearchSessionState,
} from "@/lib/search-session";

/**
 * The behaviour these lock down, in the guard's terms:
 *
 *   · Typing a unit number is ONE lookup, not one per keystroke.
 *   · Typing over the previous unit after a pause is a NEW lookup — this is
 *     the case the old empty→non-empty rule missed entirely, and the reason
 *     the metric read as engagement rather than lookups.
 *   · Typing over it immediately is still the SAME lookup.
 *   · Clearing the box (ⓧ or backspace, they are identical) also ends it.
 */

const T0 = 1_770_000_000_000; // fixed epoch — no wall clock in tests

/** Replay a script of [query, atMs] and return one entry per fired event. */
function run(script: [string, number][], idleMs = SEARCH_SESSION_IDLE_MS) {
  let state: SearchSessionState = EMPTY_SEARCH_SESSION;
  const fired: { query: string; atMs: number; afterIdle: boolean }[] = [];
  for (const [query, atMs] of script) {
    const step = advanceSearchSession(state, query, atMs, idleMs);
    state = step.next;
    if (step.started) fired.push({ query, atMs, afterIdle: step.afterIdle });
  }
  return { fired, state };
}

describe("advanceSearchSession", () => {
  test("typing one unit number fires exactly once", () => {
    const { fired } = run([
      ["3", T0],
      ["36", T0 + 120],
      ["369", T0 + 240],
      ["3692", T0 + 360],
    ]);
    expect(fired.map((f) => f.query)).toEqual(["3"]);
    expect(fired[0].afterIdle).toBe(false);
  });

  test("typing over the previous unit right away is the SAME lookup", () => {
    const { fired } = run([
      ["3692", T0],
      ["", T0 + 1_000], // select-all + type replaces in one step for RN inputs,
      ["1715", T0 + 1_001], // but backspace-to-empty is the same path
    ]);
    // The clear is what starts the second one, not the idle rule.
    expect(fired).toHaveLength(2);
    expect(fired[1].afterIdle).toBe(false);
  });

  test("typing over it WITHOUT clearing, after the idle window, is a NEW lookup", () => {
    // The exact gap the old rule missed: box never empties, so empty→non-empty
    // never happens, and the second car went uncounted.
    const { fired } = run([
      ["3692", T0],
      ["1715", T0 + SEARCH_SESSION_IDLE_MS + 1],
    ]);
    expect(fired.map((f) => f.query)).toEqual(["3692", "1715"]);
    expect(fired[1].afterIdle).toBe(true);
  });

  test("a pause SHORTER than the window keeps the same session", () => {
    const { fired } = run([
      ["3692", T0],
      ["36925", T0 + SEARCH_SESSION_IDLE_MS - 1],
    ]);
    expect(fired).toHaveLength(1);
  });

  test("the idle window is measured from the last keystroke, not the first", () => {
    // Steady typing across more than the window must not split the session.
    const step = Math.floor(SEARCH_SESSION_IDLE_MS / 2);
    const { fired } = run([
      ["3", T0],
      ["36", T0 + step],
      ["369", T0 + step * 2],
      ["3692", T0 + step * 3], // T0 + 1.5x the window, but never idle
    ]);
    expect(fired).toHaveLength(1);
  });

  test("blank is empty — a lingering space cannot hold a session open", () => {
    const { fired, state } = run([
      ["3692", T0],
      ["   ", T0 + 500],
      ["1715", T0 + 600],
    ]);
    expect(fired.map((f) => f.query)).toEqual(["3692", "1715"]);
    expect(state.active).toBe(true);
  });

  test("whitespace alone never opens a session", () => {
    const { fired, state } = run([
      [" ", T0],
      ["  ", T0 + 100],
    ]);
    expect(fired).toHaveLength(0);
    expect(state.active).toBe(false);
  });

  test("an empty box stays closed no matter how long it sits", () => {
    const { fired } = run([
      ["", T0],
      ["", T0 + SEARCH_SESSION_IDLE_MS * 10],
    ]);
    expect(fired).toHaveLength(0);
  });

  test("the first ever input fires, and is not reported as an idle restart", () => {
    // lastInputAt starts at 0, so now - 0 is astronomically over the window —
    // the `prev.active` guard is what stops that being mislabelled.
    const { fired } = run([["3692", T0]]);
    expect(fired).toHaveLength(1);
    expect(fired[0].afterIdle).toBe(false);
  });

  test("a full shift of type-over lookups is counted, not collapsed to one", () => {
    const gap = SEARCH_SESSION_IDLE_MS + 60_000;
    const { fired } = run([
      ["3692", T0],
      ["1715", T0 + gap],
      ["3584", T0 + gap * 2],
      ["1806", T0 + gap * 3],
    ]);
    expect(fired).toHaveLength(4);
    expect(fired.slice(1).every((f) => f.afterIdle)).toBe(true);
  });

  test("is a pure fold — the same input twice yields the same result", () => {
    const prev: SearchSessionState = { active: true, lastInputAt: T0 };
    const a = advanceSearchSession(prev, "3692", T0 + 5_000);
    const b = advanceSearchSession(prev, "3692", T0 + 5_000);
    expect(a).toEqual(b);
    expect(prev).toEqual({ active: true, lastInputAt: T0 }); // not mutated
  });
});
