/**
 * Placing dictated text into the notes editor.
 *
 * Apple's recognizer streams *replacements*, not appends: each partial is the
 * whole utterance so far, revised. So dictation owns a span of the document and
 * rewrites it in place — appending each partial would stutter the text
 * ("Replaced Replaced the Replaced the valve").
 *
 * Pure on purpose: the sheet holds the draft, this decides what it becomes.
 */

export interface DictationSpan {
  /** Where the dictated run begins in the document. */
  anchor: number;
  /** How much of the document the run currently occupies. */
  length: number;
}

export interface EditResult {
  text: string;
  span: DictationSpan;
  /** Where the caret lands — always the end of the dictated run. */
  caret: number;
}

/**
 * Open a dictation run at the caret, replacing any selection (the same thing
 * typing would do). Returns the span the run will rewrite from here.
 */
export function beginDictation(text: string, selStart: number, selEnd: number): EditResult {
  const start = Math.max(0, Math.min(selStart, selEnd, text.length));
  const end = Math.max(0, Math.min(Math.max(selStart, selEnd), text.length));
  const next = text.slice(0, start) + text.slice(end);
  return { text: next, span: { anchor: start, length: 0 }, caret: start };
}

/**
 * True when dictation should insert a separating space — i.e. it starts hard
 * against a word. Without it "…the tank" + "Recommend" becomes "tankRecommend".
 * Never doubles an existing space, and never leads a line or an open bracket.
 */
function needsLeadingSpace(text: string, anchor: number): boolean {
  if (anchor === 0) return false;
  const prev = text[anchor - 1];
  return !/[\s([{"'‘“\-–—]/.test(prev);
}

/**
 * Rewrite the dictated span with the latest transcript.
 *
 * `span.length` is what the previous partial left behind, so this is
 * idempotent: feeding the same transcript twice yields the same document.
 */
export function applyTranscript(text: string, span: DictationSpan, transcript: string): EditResult {
  const anchor = Math.max(0, Math.min(span.anchor, text.length));
  const end = Math.max(anchor, Math.min(anchor + span.length, text.length));
  const trimmed = transcript.trim();

  // An empty transcript retracts the run rather than leaving a stray space —
  // the recognizer does revise a partial down to nothing.
  if (trimmed.length === 0) {
    const next = text.slice(0, anchor) + text.slice(end);
    return { text: next, span: { anchor, length: 0 }, caret: anchor };
  }

  const lead = needsLeadingSpace(text, anchor) ? " " : "";
  const insert = lead + trimmed;
  const next = text.slice(0, anchor) + insert + text.slice(end);
  return { text: next, span: { anchor, length: insert.length }, caret: anchor + insert.length };
}

/**
 * Close the run. The text already reads correctly, so this only reports where
 * the caret belongs and hands back a span the next run can start from.
 */
export function endDictation(span: DictationSpan): number {
  return span.anchor + span.length;
}
