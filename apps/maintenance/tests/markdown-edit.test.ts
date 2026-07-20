import { expect, test } from "bun:test";
import {
  activeStyles,
  lineStyleOf,
  toggleBold,
  toggleCheckboxAtLine,
  toggleLineStyle,
} from "../lib/markdown-edit";

test("lineStyleOf reads the markdown-lite prefixes", () => {
  expect(lineStyleOf("# Visit 1")).toBe("h1");
  expect(lineStyleOf("## Parts")).toBe("h2");
  expect(lineStyleOf("- 20A GFCI breaker")).toBe("bullet");
  expect(lineStyleOf("- [ ] Test circuit")).toBe("checkbox");
  expect(lineStyleOf("- [x] Confirmed trip")).toBe("checkbox");
  expect(lineStyleOf("plain text")).toBe("none");
});

test("heading cycles none → # → ## → none", () => {
  const a = toggleLineStyle("Visit 1", 0, 0, "heading");
  expect(a.text).toBe("# Visit 1");
  const b = toggleLineStyle(a.text, a.selStart, a.selEnd, "heading");
  expect(b.text).toBe("## Visit 1");
  const c = toggleLineStyle(b.text, b.selStart, b.selEnd, "heading");
  expect(c.text).toBe("Visit 1");
});

test("heading converts a bullet line in place", () => {
  expect(toggleLineStyle("- Parts", 3, 3, "heading").text).toBe("# Parts");
});

test("bullet toggles on and off", () => {
  const on = toggleLineStyle("20A breaker", 0, 0, "bullet");
  expect(on.text).toBe("- 20A breaker");
  const off = toggleLineStyle(on.text, on.selStart, on.selEnd, "bullet");
  expect(off.text).toBe("20A breaker");
});

test("checkbox toggles and converts a bullet, keeping [x] when re-prefixed", () => {
  const on = toggleLineStyle("- Order GFCI", 4, 4, "checkbox");
  expect(on.text).toBe("- [ ] Order GFCI");
  const off = toggleLineStyle(on.text, on.selStart, on.selEnd, "checkbox");
  expect(off.text).toBe("Order GFCI");
});

test("line toggles apply across a multi-line selection", () => {
  const text = "one\ntwo\nthree";
  const all = toggleLineStyle(text, 0, text.length, "checkbox");
  expect(all.text).toBe("- [ ] one\n- [ ] two\n- [ ] three");
});

test("toggleBold wraps a selection and unwraps it again", () => {
  const text = "Breaker labeled Kitchen trips";
  const start = text.indexOf("Kitchen");
  const end = start + "Kitchen".length;
  const on = toggleBold(text, start, end);
  expect(on.text).toBe("Breaker labeled **Kitchen** trips");
  // Selection now sits inside the markers; toggling again unwraps.
  const off = toggleBold(on.text, on.selStart, on.selEnd);
  expect(off.text).toBe(text);
});

test("toggleBold with a collapsed caret inserts markers and parks inside", () => {
  const r = toggleBold("note ", 5, 5);
  expect(r.text).toBe("note ****");
  expect(r.selStart).toBe(7);
  expect(r.selEnd).toBe(7);
});

test("toggleCheckboxAtLine flips only its line", () => {
  const text = "- [ ] one\n- [x] two\nplain";
  expect(toggleCheckboxAtLine(text, 0)).toBe("- [x] one\n- [x] two\nplain");
  expect(toggleCheckboxAtLine(text, 1)).toBe("- [ ] one\n- [ ] two\nplain");
  expect(toggleCheckboxAtLine(text, 2)).toBe(text);
});

test("activeStyles reports the caret's line style and bold runs", () => {
  const text = "# Head\nBreaker **Kitchen** trips\n- [ ] step";
  expect(activeStyles(text, 2, 2).line).toBe("h1");
  const kitchenAt = text.indexOf("Kitchen") + 3;
  const inBold = activeStyles(text, kitchenAt, kitchenAt);
  expect(inBold.bold).toBe(true);
  expect(activeStyles(text, text.length, text.length).line).toBe("checkbox");
  expect(activeStyles(text, 0, 0).bold).toBe(false);
});
