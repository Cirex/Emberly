const assert = require("node:assert/strict");
const test = require("node:test");

const { isMakeReadyTemplateTitle, isMakeReadyCategory } = require("../dist/index.js");

/**
 * The property files four standard turn tasks under the trade that performs
 * them, with ResMan's MakeReady flag unset — so they reached the Closed board
 * despite belonging to the make-ready tab.
 */
test("the four turn templates are recognised", () => {
  for (const title of [
    "Trash Out",
    "Clean, Replace, Repair flooring",
    "Rekey and reassign Traka",
    "Touch up Painting",
  ]) {
    assert.equal(isMakeReadyTemplateTitle(title), true, `${title} should be make-ready`);
  }
});

test("matching is case- and whitespace-insensitive, since ResMan casing varies", () => {
  // Prod holds "Trash Out", "trash out" and "Trash out" for the same template.
  for (const v of ["trash out", "TRASH OUT", "  Trash   Out  ", "\tTrash Out\n"]) {
    assert.equal(isMakeReadyTemplateTitle(v), true, JSON.stringify(v));
  }
});

/**
 * THE POINT OF THE WHOLE RULE. These are real prod titles containing the same
 * stage words. A regex on `flooring|cleaning|touch up paint|rekey` hides all of
 * them — genuine resident work orders vanishing off the boards, which is a far
 * worse bug than the one being fixed.
 */
test("resident work orders containing the same words are NOT hidden", () => {
  for (const title of [
    "flooring is pealing off in the kitchen and bathroom.",
    "the HVAC  needs cleaning and it needs a filter , it wasn't one",
    "Stove caught fire I tried cleaning it but need a new one",
    "NO HOT WATER IN UNIT, needs touch up cleaning, and exhaust fan",
    "Flooring peeling up in kitchen",
    "bad flooring",
    "rekey apartment lock",
    "kitchen door lock rekey",
    "floors and restrooms need cleaning",
    "trash out this unit",
    "trash out - clean",
    "black scuffs on flooring in living room",
  ]) {
    assert.equal(isMakeReadyTemplateTitle(title), false, `${title} must stay on the boards`);
  }
});

test("a near-miss template is not matched — exact text only", () => {
  // Partial or extended phrasings are one-off prose, not the template.
  assert.equal(isMakeReadyTemplateTitle("trash"), false);
  assert.equal(isMakeReadyTemplateTitle("touch up"), false);
  assert.equal(isMakeReadyTemplateTitle("repair flooring"), false);
  assert.equal(isMakeReadyTemplateTitle("trash out has not been done"), false);
});

test("empty and missing titles are safe", () => {
  assert.equal(isMakeReadyTemplateTitle(""), false);
  assert.equal(isMakeReadyTemplateTitle(null), false);
  assert.equal(isMakeReadyTemplateTitle(undefined), false);
});

test("the comma in the flooring template is significant, not punctuation noise", () => {
  // Normalisation touches whitespace and case only. Stripping punctuation would
  // start matching prose that merely lists the same words.
  assert.equal(isMakeReadyTemplateTitle("Clean, Replace, Repair flooring"), true);
  assert.equal(isMakeReadyTemplateTitle("Clean Replace Repair flooring"), false);
});

test("the category rule is unchanged and still independent", () => {
  assert.equal(isMakeReadyCategory("Make Ready Maintenance"), true);
  assert.equal(isMakeReadyCategory("Turn Maintenance/Punch"), true);
  // The four templates live under ordinary trade categories — which is exactly
  // why the category rule alone never caught them.
  for (const c of ["Trash and Debris", "Flooring", "Locks and Keys", "Painting"]) {
    assert.equal(isMakeReadyCategory(c), false, `${c} is an ordinary trade category`);
  }
});
