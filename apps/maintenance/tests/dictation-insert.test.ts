import { describe, expect, test } from "bun:test";

import { applyTranscript, beginDictation, endDictation } from "@/lib/dictation/insert";

describe("beginDictation", () => {
  test("opens a zero-length run at the caret", () => {
    const r = beginDictation("Replaced the valve", 8, 8);
    expect(r.text).toBe("Replaced the valve");
    expect(r.span).toEqual({ anchor: 8, length: 0 });
    expect(r.caret).toBe(8);
  });

  test("replaces a selection, the way typing would", () => {
    const r = beginDictation("Replaced the valve", 9, 12); // "the"
    expect(r.text).toBe("Replaced  valve");
    expect(r.span.anchor).toBe(9);
    expect(r.caret).toBe(9);
  });

  test("clamps a caret past the end of the document", () => {
    const r = beginDictation("abc", 99, 99);
    expect(r.span.anchor).toBe(3);
    expect(r.text).toBe("abc");
  });

  test("tolerates a backwards selection", () => {
    const r = beginDictation("Replaced the valve", 12, 9);
    expect(r.text).toBe("Replaced  valve");
    expect(r.span.anchor).toBe(9);
  });
});

describe("applyTranscript", () => {
  test("partials replace rather than append", () => {
    // The bug this exists to prevent: appending each partial stutters the text.
    let state = beginDictation("", 0, 0);
    state = applyTranscript(state.text, state.span, "Replaced");
    state = applyTranscript(state.text, state.span, "Replaced the");
    state = applyTranscript(state.text, state.span, "Replaced the valve");
    expect(state.text).toBe("Replaced the valve");
  });

  test("is idempotent — the same transcript twice is the same document", () => {
    let state = beginDictation("", 0, 0);
    state = applyTranscript(state.text, state.span, "Bled the tank");
    const once = state.text;
    state = applyTranscript(state.text, state.span, "Bled the tank");
    expect(state.text).toBe(once);
  });

  test("inserts mid-document without disturbing what surrounds it", () => {
    const base = "Findings: . Recommend a swap.";
    let state = beginDictation(base, 10, 10);
    state = applyTranscript(state.text, state.span, "valve was seized");
    expect(state.text).toBe("Findings: valve was seized. Recommend a swap.");
  });

  test("adds a separating space when it lands against a word", () => {
    let state = beginDictation("Bled the tank", 13, 13);
    state = applyTranscript(state.text, state.span, "and tested it");
    expect(state.text).toBe("Bled the tank and tested it");
  });

  test("does not double a space that is already there", () => {
    let state = beginDictation("Bled the tank ", 14, 14);
    state = applyTranscript(state.text, state.span, "and tested it");
    expect(state.text).toBe("Bled the tank and tested it");
  });

  test("does not lead a line with a space", () => {
    let state = beginDictation("", 0, 0);
    state = applyTranscript(state.text, state.span, "Replaced the valve");
    expect(state.text).toBe("Replaced the valve");
  });

  test("does not push a space after an opening bracket or quote", () => {
    for (const opener of ["(", "[", '"', "- "]) {
      let state = beginDictation(opener, opener.length, opener.length);
      state = applyTranscript(state.text, state.span, "anode rod");
      expect(state.text).toBe(`${opener}anode rod`);
    }
  });

  test("a markdown bullet prefix keeps the dictation flush to it", () => {
    const base = "## Findings\n- ";
    let state = beginDictation(base, base.length, base.length);
    state = applyTranscript(state.text, state.span, "T&P valve leaking");
    expect(state.text).toBe("## Findings\n- T&P valve leaking");
  });

  test("a transcript revised to nothing retracts the run cleanly", () => {
    let state = beginDictation("Bled the tank", 13, 13);
    state = applyTranscript(state.text, state.span, "and");
    state = applyTranscript(state.text, state.span, "");
    // No orphaned separating space left behind.
    expect(state.text).toBe("Bled the tank");
    expect(state.span.length).toBe(0);
  });

  test("surrounding whitespace in a transcript is trimmed", () => {
    let state = beginDictation("", 0, 0);
    state = applyTranscript(state.text, state.span, "  Replaced the valve  ");
    expect(state.text).toBe("Replaced the valve");
  });

  test("the caret tracks the end of the dictated run", () => {
    let state = beginDictation("Notes: ", 7, 7);
    state = applyTranscript(state.text, state.span, "anode rod spent");
    expect(state.caret).toBe(state.text.length);
    expect(endDictation(state.span)).toBe(state.text.length);
  });

  test("a second run starts after the first and does not eat it", () => {
    let first = beginDictation("", 0, 0);
    first = applyTranscript(first.text, first.span, "Replaced the valve.");
    const caret = endDictation(first.span);

    let second = beginDictation(first.text, caret, caret);
    second = applyTranscript(second.text, second.span, "Flushed the tank.");
    expect(second.text).toBe("Replaced the valve. Flushed the tank.");
  });
});
