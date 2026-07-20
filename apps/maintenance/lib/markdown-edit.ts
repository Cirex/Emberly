/**
 * Pure text transforms behind the markdown editor's toolbar (approved mockup
 * b2ecb737). The dialect is the app's markdown-lite — the exact subset
 * MarkdownLite renders: #/## headings, "- " bullets, "- [ ]"/"- [x]"
 * checkboxes, **bold** runs. Every function takes (text, selection) and
 * returns the new text plus where the caret belongs, so the editor can apply
 * the result in one state write.
 */

export interface EditResult {
  text: string;
  selStart: number;
  selEnd: number;
}

export type LineStyle = "none" | "h1" | "h2" | "bullet" | "checkbox";

const CHECKBOX_RE = /^(\s*)- \[( |x|\*)\] /i;
const BULLET_RE = /^(\s*)- (?!\[)/;
const H2_RE = /^(\s*)## /;
const H1_RE = /^(\s*)# (?!#)/;

export function lineStyleOf(line: string): LineStyle {
  if (CHECKBOX_RE.test(line)) return "checkbox";
  if (BULLET_RE.test(line)) return "bullet";
  if (H2_RE.test(line)) return "h2";
  if (H1_RE.test(line)) return "h1";
  return "none";
}

/** Strip any line-leading markdown-lite prefix, preserving indentation. */
function stripPrefix(line: string): string {
  return line
    .replace(CHECKBOX_RE, "$1")
    .replace(BULLET_RE, "$1")
    .replace(H2_RE, "$1")
    .replace(H1_RE, "$1");
}

/** [start, end) index range of every line touched by the selection. */
function lineRangeOf(text: string, selStart: number, selEnd: number): { from: number; to: number } {
  const from = text.lastIndexOf("\n", Math.max(0, selStart - 1)) + 1;
  const nextBreak = text.indexOf("\n", selEnd);
  const to = nextBreak === -1 ? text.length : nextBreak;
  return { from, to };
}

/**
 * Toggle a line-level style across every line the selection touches:
 * - heading: cycles none → "# " → "## " → none (per the mockup's H button)
 * - bullet / checkbox: toggle off when every touched line already has it,
 *   otherwise apply it (converting any other prefix in place).
 * The caret lands at the end of the last transformed line's prefix change,
 * keeping multi-line selections selected.
 */
export function toggleLineStyle(
  text: string,
  selStart: number,
  selEnd: number,
  kind: "heading" | "bullet" | "checkbox",
): EditResult {
  const { from, to } = lineRangeOf(text, selStart, selEnd);
  const block = text.slice(from, to);
  const lines = block.split("\n");
  const styles = lines.map(lineStyleOf);

  const next = lines.map((line, i) => {
    const bare = stripPrefix(line);
    const indent = /^\s*/.exec(bare)?.[0] ?? "";
    const body = bare.slice(indent.length);
    switch (kind) {
      case "heading": {
        // Cycle by the FIRST line's current style so a mixed selection is
        // driven predictably.
        const cur = styles[0];
        if (cur === "h1") return `${indent}## ${body}`;
        if (cur === "h2") return `${indent}${body}`;
        return `${indent}# ${body}`;
      }
      case "bullet": {
        const allBullet = styles.every((s) => s === "bullet");
        return allBullet ? `${indent}${body}` : `${indent}- ${body}`;
      }
      case "checkbox": {
        const allCheckbox = styles.every((s) => s === "checkbox");
        // A checked line keeps its check when other lines join the toggle.
        if (allCheckbox) return `${indent}${body}`;
        const checked = CHECKBOX_RE.exec(line)?.[2];
        const mark = checked && checked !== " " ? "x" : " ";
        return `${indent}- [${mark}] ${body}`;
      }
    }
  });

  const nextBlock = next.join("\n");
  const nextText = text.slice(0, from) + nextBlock + text.slice(to);
  const delta = nextBlock.length - block.length;
  // Keep the selection over the same logical span.
  const selStartNext = Math.max(from, selStart + (next[0].length - lines[0].length));
  return { text: nextText, selStart: selStartNext, selEnd: Math.max(selStartNext, selEnd + delta) };
}

/**
 * Bold: wrap the selection in `**`; unwrap when the selection is exactly a
 * bold run's inside (or includes its markers). A collapsed caret inserts
 * `****` and parks the caret between the markers.
 */
export function toggleBold(text: string, selStart: number, selEnd: number): EditResult {
  if (selStart === selEnd) {
    const insert = "****";
    const nextText = text.slice(0, selStart) + insert + text.slice(selEnd);
    return { text: nextText, selStart: selStart + 2, selEnd: selStart + 2 };
  }
  const inner = text.slice(selStart, selEnd);
  // Selection includes the markers: **bold** selected whole.
  if (inner.startsWith("**") && inner.endsWith("**") && inner.length >= 4) {
    const stripped = inner.slice(2, -2);
    const nextText = text.slice(0, selStart) + stripped + text.slice(selEnd);
    return { text: nextText, selStart, selEnd: selStart + stripped.length };
  }
  // Markers sit just outside the selection: **|bold|**.
  if (text.slice(selStart - 2, selStart) === "**" && text.slice(selEnd, selEnd + 2) === "**") {
    const nextText = text.slice(0, selStart - 2) + inner + text.slice(selEnd + 2);
    return { text: nextText, selStart: selStart - 2, selEnd: selEnd - 2 };
  }
  const nextText = `${text.slice(0, selStart)}**${inner}**${text.slice(selEnd)}`;
  return { text: nextText, selStart: selStart + 2, selEnd: selEnd + 2 };
}

/** Flip `[ ]` ⇄ `[x]` on the given (0-based) line. No-op on non-checkboxes. */
export function toggleCheckboxAtLine(text: string, lineIndex: number): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const line = lines[lineIndex];
  if (line === undefined) return text;
  const m = CHECKBOX_RE.exec(line);
  if (!m) return text;
  const checked = m[2] !== " ";
  lines[lineIndex] = line.replace(CHECKBOX_RE, `$1- [${checked ? " " : "x"}] `);
  return lines.join("\n");
}

export interface ActiveStyles {
  bold: boolean;
  line: LineStyle;
}

/** Toolbar highlight state for the caret / selection position. */
export function activeStyles(text: string, selStart: number, selEnd: number): ActiveStyles {
  const { from, to } = lineRangeOf(text, selStart, selEnd);
  const line = text.slice(from, to).split("\n")[0];
  // Bold when the caret sits strictly inside a **run** on its line. Walk the
  // line's marker pairs rather than regex-matching the whole text so an odd
  // marker count can't confuse the highlight.
  let bold = false;
  const caretInLine = selStart - from;
  let idx = 0;
  const markers: number[] = [];
  for (;;) {
    const at = line.indexOf("**", idx);
    if (at === -1) break;
    markers.push(at);
    idx = at + 2;
  }
  for (let i = 0; i + 1 < markers.length; i += 2) {
    if (caretInLine > markers[i] + 1 && caretInLine <= markers[i + 1]) {
      bold = true;
      break;
    }
  }
  return { bold, line: lineStyleOf(line) };
}
