import { expect, test } from "bun:test";
import { computeWorkOrderSignals, type EngineOrder } from "../lib/derived/wo-engine";
import { deriveWorkOrderTags } from "../lib/derived/wo-tags";
import { tagIconName, tagTint } from "../lib/derived/tags";

const tags = (title: string, desc = "") => deriveWorkOrderTags(title, desc, "");

test("deriveWorkOrderTags reads the trade from real titles", () => {
  expect(tags("AC not cooling")).toContain("HVAC");
  expect(tags("A/C IS OUT")).toContain("HVAC");
  expect(tags("Bottom of refrigerator not working")).toContain("Refrigerator");
  expect(tags("stove caught on fire")).toContain("Range");
  expect(tags("leaking in kitchen and bathroom in the master room")).toContain("Leaks");
  expect(tags("Mold present in main bathroom.")).toContain("Mold");
  expect(tags("Toilet is clogged and backed up in the bathroom")).toContain("Clogs");
  expect(tags("breaker keeps tripping in the bedroom")).toContain("Electrical");
});

test("deriveWorkOrderTags suppresses make-ready orders", () => {
  expect(tags("Make Ready - Punch")).toEqual([]);
});

test("deriveWorkOrderTags separates a fridge from HVAC cooling", () => {
  // A refrigerator "not cooling" must not read as an HVAC ticket.
  const t = tags("refrigerator not cooling, bottom not cold");
  expect(t).toContain("Refrigerator");
  expect(t).not.toContain("HVAC");
});

// --- Toilet routing (2026-07-19 decision: toilet issues → leak or clog) ------

test("deriveWorkOrderTags routes a non-flushing toilet to Clogs", () => {
  expect(tags("toilet won't flush")).toContain("Clogs");
  expect(tags("toilet not flushing")).toContain("Clogs");
  expect(tags("Toilet is clogged and backed up in the bathroom")).toContain("Clogs");
});

test("deriveWorkOrderTags routes a leaking toilet to Leaks, not Clogs", () => {
  expect(tags("leaking toilet")).toContain("Leaks");
  expect(tags("toilet leaking")).toEqual(["Leaks"]);
});

test("deriveWorkOrderTags treats a running / won't-shut-off toilet as a Leak", () => {
  // Continuous running water = wasted water → Leak (matches the mojibake
  // apostrophe seen in real ResMan data: "won?t").
  expect(tags("Toilet water won?t go off")).toContain("Leaks");
  expect(tags("toilet keeps running")).toContain("Leaks");
  expect(tags("toilet won't stop running")).toContain("Leaks");
});

// --- Water Damage vs active Leak (active wins; past → Water Damage, never both) ---

test("deriveWorkOrderTags keeps an ACTIVE leak as Leaks, not Water Damage", () => {
  expect(tags("Kitchen sink leaking underneath front P-Trap")).toEqual(["Leaks"]);
  expect(tags("House flooding with rainwater")).toContain("Leaks");
  const t = tags("major leak from upstairs");
  expect(t).toContain("Leaks");
  expect(t).not.toContain("Water Damage");
});

test("deriveWorkOrderTags routes a PAST/repaired leak to Water Damage, suppressing Leaks", () => {
  for (const title of [
    "Drywall needs to be replaced in the bathroom from prevoius leak in the unit above",
    "bath and kitchen ceiling — leak repaired need cut out completely in both bath",
    "The kitchen floor been damage since the leak",
  ]) {
    const t = tags(title);
    expect(t).toContain("Water Damage");
    expect(t).not.toContain("Leaks");
  }
});

test("deriveWorkOrderTags tags a dried stain / sheetrock repair as Water Damage", () => {
  expect(tags("wall stained needs repair and paint, Kitchen")).toEqual(["Water Damage"]);
  expect(tags("ceiling has a big hole", "sheetrock needs to be done")).toContain("Water Damage");
  expect(tags("Ceiling plaster is falling")).toContain("Water Damage");
});

// --- Structure trades: Doors/Locks, Windows/Screens/Blinds, Cabinets/Countertops ---

test("deriveWorkOrderTags tags door and lock faults as Doors/Locks", () => {
  expect(tags("front doorknob will not turn")).toEqual(["Doors/Locks"]);
  expect(tags("Door off hinge")).toEqual(["Doors/Locks"]);
  expect(tags("lock needs to be replaced on the main bedroom")).toContain("Doors/Locks");
  expect(tags("both doors are badly bowed and need to be replaced")).toContain("Doors/Locks");
});

test("deriveWorkOrderTags does not read a mailbox lock as a door lock", () => {
  const t = tags("mailbox lock is broken");
  expect(t).toContain("Mail Box");
  expect(t).not.toContain("Doors/Locks");
});

test("deriveWorkOrderTags tags screens/blinds/glass swaps as Windows/Screens/Blinds", () => {
  expect(tags("Need blinds replaced")).toEqual(["Windows/Screens/Blinds"]);
  expect(tags("Lr glass replacement")).toContain("Windows/Screens/Blinds");
});

test("deriveWorkOrderTags keeps a broken pane as Broken Window, distinct from the window family", () => {
  const shattered = tags("window is shattered");
  expect(shattered).toContain("Broken Window");
  expect(shattered).not.toContain("Windows/Screens/Blinds");
  expect(tags("NEEDS REPLACEMENT", "WINDOW WAS SHOT")).toContain("Broken Window");
});

test("deriveWorkOrderTags does not read a window AC unit as a window covering", () => {
  expect(tags("window unit", "portable unit issued until AC can be repaired")).not.toContain(
    "Windows/Screens/Blinds",
  );
});

test("deriveWorkOrderTags tags cabinet and countertop work as Cabinets/Countertops", () => {
  expect(tags("cabinet in the kitchen came off the hinges")).toEqual(["Cabinets/Countertops"]);
  expect(tags("kitchen cabinets been down since the storm")).toContain("Cabinets/Countertops");
  expect(tags("Counter top and ceiling")).toContain("Cabinets/Countertops");
});

test("deriveWorkOrderTags suppresses batch turn-inspection checklists", () => {
  expect(
    tags("Inspect Ready Units Batch 2c", "Check for: visible damage, doors, windows, leaks/mold"),
  ).toEqual([]);
});

// --- Icon + tint mappings for the new tags -----------------------------------

test("tagIconName maps the new tags to distinct MaterialCommunityIcons glyphs", () => {
  expect(tagIconName("Water Damage")).toBe("water-alert-outline");
  expect(tagIconName("Doors/Locks")).toBe("door");
  expect(tagIconName("Windows/Screens/Blinds")).toBe("window-closed-variant");
  expect(tagIconName("Cabinets/Countertops")).toBe("cupboard-outline");
  // Broken Window keeps its glass glyph — not the generic window glyph.
  expect(tagIconName("Broken Window")).toBe("glass-fragile");
});

test("tagTint gives Water Damage its own repair tint, structure tags stay neutral", () => {
  expect(tagTint("Water Damage")).toBe("#8A6D3B");
  expect(tagTint("Leaks")).not.toBe(tagTint("Water Damage")); // visually distinct from active Leak
  expect(tagTint("Doors/Locks")).toBe("#2A66AC");
  expect(tagTint("Cabinets/Countertops")).toBe("#2A66AC");
});

const order = (o: Partial<EngineOrder> & { id: string }): EngineOrder => ({
  unitNumber: "3613 KG-1",
  status: "Not Started",
  title: "",
  description: "",
  category: "",
  tags: [],
  completionNotes: "",
  reportedAt: null,
  completedAt: null,
  ...o,
});

const DAY = 86_400_000;

test("computeWorkOrderSignals flags a re-report in the same unit as a possible callback", () => {
  const base = Date.parse("2026-01-01T00:00:00Z");
  const completed = order({
    id: "done",
    status: "Completed",
    title: "AC not cooling",
    tags: ["HVAC"],
    reportedAt: base,
    completedAt: base + 2 * DAY,
  });
  const reopened = order({
    id: "open",
    status: "Not Started",
    title: "AC still not cooling after repair",
    tags: ["HVAC"],
    reportedAt: base + 10 * DAY,
  });
  const signals = computeWorkOrderSignals([completed, reopened]);
  expect(signals.get("open")?.callbackStatus).toBe("possible");
  expect(signals.get("open")?.callbackMatchedId).toBe("done");
});

test("computeWorkOrderSignals does not link across different units", () => {
  const base = Date.parse("2026-01-01T00:00:00Z");
  const completed = order({ id: "done", unitNumber: "3613 KG-1", status: "Completed", title: "AC out", tags: ["HVAC"], reportedAt: base, completedAt: base + DAY });
  const other = order({ id: "open", unitNumber: "3613 KG-2", status: "Not Started", title: "AC out", tags: ["HVAC"], reportedAt: base + 5 * DAY });
  const signals = computeWorkOrderSignals([completed, other]);
  expect(signals.get("open")?.callbackStatus ?? "none").toBe("none");
});
