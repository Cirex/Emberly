import { describe, expect, test } from "bun:test";
import {
  EMPTY_SEARCH_SESSION,
  SEARCH_SESSION_IDLE_MS,
  SEARCH_SESSION_REOPEN_MS,
  advanceSearchSession,
  type SearchSessionState,
} from "@/lib/search-session";

/**
 * The behaviour these lock down, in the guard's terms:
 *
 *   · Typing a unit number is ONE lookup, not one per keystroke.
 *   · Typing over the previous unit after a pause is a NEW lookup — the case
 *     the old empty→non-empty rule missed entirely, and the reason the metric
 *     read as engagement rather than lookups.
 *   · Typing over it within the idle window is still the SAME lookup.
 *   · Clearing the box ends it — but only if the box STAYS blank. Correcting
 *     a mistyped digit passes through empty in ~200ms and must not score
 *     twice; that regression shipped once and these tests exist to keep it
 *     from shipping again.
 *   · ⓧ and backspace are indistinguishable: both only drive the value empty.
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

  test("a deliberate clear, then a new unit, is two lookups", () => {
    const { fired } = run([
      ["3692", T0],
      ["", T0 + 2_000],
      ["1715", T0 + 2_000 + SEARCH_SESSION_REOPEN_MS], // blank long enough to count
    ]);
    expect(fired.map((f) => f.query)).toEqual(["3692", "1715"]);
    expect(fired[1].afterIdle).toBe(false); // ended by the clear, not by idle
  });

  test("BACKSPACE-AND-RETYPE IS ONE LOOKUP, not two", () => {
    // The regression that shipped and had to be fixed: the box passes through
    // empty in ~200ms while correcting a mistyped digit, and treating a clear
    // as an instant session end scored that single lookup twice.
    const { fired } = run([
      ["3", T0], // wrong digit
      ["", T0 + 180], // backspaced out
      ["1", T0 + 360], // right one
      ["17", T0 + 500],
      ["171", T0 + 640],
      ["1715", T0 + 780],
    ]);
    expect(fired.map((f) => f.query)).toEqual(["3"]);
  });

  test("the blank must LAST — one millisecond under the window is still mid-edit", () => {
    const { fired } = run([
      ["3692", T0],
      ["", T0 + 100],
      ["1715", T0 + 100 + SEARCH_SESSION_REOPEN_MS - 1],
    ]);
    expect(fired).toHaveLength(1);
  });

  test("a long blank does not keep re-arming itself into never reopening", () => {
    // emptiedAt is stamped on the TRANSITION only. If every blank keystroke
    // re-stamped it, this sequence would never reopen.
    const { fired } = run([
      ["3692", T0],
      ["", T0 + 100],
      ["  ", T0 + 200],
      ["", T0 + 300],
      ["1715", T0 + 100 + SEARCH_SESSION_REOPEN_MS],
    ]);
    expect(fired.map((f) => f.query)).toEqual(["3692", "1715"]);
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

  test('blank is empty — whitespace ends a session exactly as "" does', () => {
    const { fired, state } = run([
      ["3692", T0],
      ["   ", T0 + 500],
      ["1715", T0 + 500 + SEARCH_SESSION_REOPEN_MS],
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

  test("works on a clock that starts near zero, not just epoch millis", () => {
    // With `emptiedAt` at 0, `nowMs - 0` happens to exceed the reopen window
    // for any epoch timestamp — so the explicit `emptiedAt === 0` escape looks
    // redundant and is not exercised by the other cases. It stops being
    // redundant the moment someone passes a relative clock (performance.now(),
    // a fake timer), where the first input would otherwise never fire.
    const step = advanceSearchSession(EMPTY_SEARCH_SESSION, "3692", 500);
    expect(step.started).toBe(true);
    expect(step.afterIdle).toBe(false);
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
    const prev: SearchSessionState = { active: true, lastInputAt: T0, emptiedAt: 0 };
    const a = advanceSearchSession(prev, "3692", T0 + 5_000);
    const b = advanceSearchSession(prev, "3692", T0 + 5_000);
    expect(a).toEqual(b);
    expect(prev).toEqual({ active: true, lastInputAt: T0, emptiedAt: 0 }); // not mutated
  });
});
