/**
 * Tag → icon mapping. Port of WorkOrderTagIcon (Swift), remapped from SF
 * Symbols to **MaterialCommunityIcons** (@expo/vector-icons) — the only
 * bundled set with real maintenance vocabulary (stove, dishwasher, fridge,
 * air-conditioner, rodent, pipe…), so tags render a specific glyph instead of
 * falling back to a generic pricetag.
 *
 * Two-phase lookup, faithful to the Swift order: the CUSTOM kinds the app drew
 * by hand are checked FIRST (so "water heater" reads as a boiler, not the
 * generic water drop the substring table would pick), then the substring table
 * top-to-bottom, first match wins.
 *
 * `active` mirrors Swift's `isActive` → `.fill` variant: selected filter chips
 * and timeline-dot glyphs use the filled form where MCI has one.
 *
 * Consumers must render with `MaterialCommunityIcons`, not `Ionicons`.
 */

/** Word set split on non-alphanumerics — Swift's word-boundary checks ("rat"
 *  must not fire on "operate", "clog" must not fire on "clogging"). */
function wordsOf(tag: string): Set<string> {
  return new Set(tag.split(/[^a-z0-9]+/).filter((w) => w.length > 0));
}

/** [required substrings (ALL must match), inactive icon, active icon]. The
 *  active name defaults to the inactive one when MCI has no filled variant. */
type Rule = [needles: string[], icon: string, activeIcon?: string];

/** Substring table (Swift's if-chain order — earlier rows shadow later ones,
 *  e.g. "air filter" must be tested before the generic HVAC "air"). */
const SUBSTRING_TABLE: Rule[] = [
  [["callback"], "arrow-u-left-top"],
  [["call back"], "arrow-u-left-top"],
  [["duplicate"], "content-duplicate"],
  [["dupe"], "content-duplicate"],
  [["make", "ready"], "format-paint"],
  [["hot"], "fire"],
  [["urgent"], "fire"],
  [["priority"], "fire"],
  [["plumb"], "water-outline", "water"],
  [["leak"], "water-outline", "water"],
  [["water"], "water-outline", "water"],
  [["electric"], "flash-outline", "flash"],
  [["power"], "flash-outline", "flash"],
  [["light"], "flash-outline", "flash"],
  [["engine"], "engine-outline", "engine"],
  [["emission"], "engine-outline", "engine"],
  [["air filter"], "air-filter"],
  [["air", "filter"], "air-filter"],
  [["hvac"], "air-conditioner"],
  [["air"], "air-conditioner"],
  [["heat"], "air-conditioner"],
  [["ac"], "air-conditioner"],
  [["range"], "stove"],
  [["stove"], "stove"],
  [["oven"], "stove"],
  [["dishwasher"], "dishwasher"],
  [["dish washer"], "dishwasher"],
  [["refrigerator"], "fridge-outline", "fridge"],
  [["fridge"], "fridge-outline", "fridge"],
  [["appliance"], "washing-machine"],
  [["lock"], "key-variant"],
  [["key"], "key-variant"],
  [["pest"], "bug-outline", "bug"],
  [["trash"], "trash-can-outline", "trash-can"],
  [["clean"], "trash-can-outline", "trash-can"],
  [["paint"], "brush"],
  [["wall"], "brush"],
];

/** Urgent-trade tints (shared by My Day chips and the detail chip row). */
export const TRADE_TINT: Record<string, string> = {
  hvac: "#B05E14",
  leak: "#2563B4",
  clog: "#5B8A3C",
  electrical: "#C79433",
};

/** Derived tags that name an urgent trade keep that trade's tint; the rest use
 *  the neutral tag blue. Keyed by the lowercased tag label. */
const TRADE_FOR_TAG: Record<string, string> = {
  leaks: "leak",
  "no hot water": "leak",
  clogs: "clog",
  hvac: "hvac",
  electrical: "electrical",
};

/** Non-trade tags that still want a distinct tint. Water Damage is water-family
 *  but NOT an urgent active-leak trade, so it reads as its own muted repair
 *  brown rather than the leak blue (keeps a dried stain visually apart from a
 *  live Leak). Structure tags stay the neutral tag blue, like Flooring. */
const TAG_TINT_OVERRIDE: Record<string, string> = {
  "water damage": "#8A6D3B",
};

/** Chip tint for a work-order tag: the urgent trade's color, an explicit
 *  override, else tag blue. */
export function tagTint(tag: string): string {
  const key = tag.toLowerCase();
  const trade = TRADE_FOR_TAG[key];
  if (trade) return TRADE_TINT[trade];
  return TAG_TINT_OVERRIDE[key] ?? "#2A66AC";
}

/** MaterialCommunityIcons name for a work-order tag. Pure; case-insensitive. */
export function tagIconName(tag: string, active = false): string {
  const t = tag.toLowerCase();
  const words = wordsOf(t);
  const has = (w: string) => words.has(w);
  const pick = (icon: string, activeIcon?: string) => (active ? (activeIcon ?? icon) : icon);

  // Custom kinds first — these were hand-drawn shapes in Swift, so they must
  // win over the generic substring table ("water heater" → boiler, not water).
  if (t.includes("no hot water") || (t.includes("hot") && t.includes("water")) || t.includes("water heater")) {
    return "water-boiler";
  }
  // Water Damage — a distinct alert-drop, so a dried stain doesn't read as the
  // generic water drop the "water" substring row would pick (which is Leaks).
  if (t.includes("water damage") || (t.includes("water") && t.includes("damage"))) {
    return pick("water-alert-outline", "water-alert");
  }
  if ((t.includes("broken") && t.includes("window")) || (t.includes("window") && t.includes("glass"))) {
    return "glass-fragile";
  }
  // Non-breakage window family (screens/blinds/frames) — after Broken Window so
  // an actual broken pane still reads as glass-fragile.
  if (t.includes("window") || t.includes("blind") || t.includes("screen")) {
    return pick("window-closed-variant", "window-open");
  }
  // Doors/Locks — a door glyph. Matches only the "door" label so the existing
  // "Lockout" tag still falls through to the key glyph in the substring table.
  if (t.includes("door")) {
    return pick("door", "door-open");
  }
  if (t.includes("cabinet") || t.includes("counter")) {
    return pick("cupboard-outline", "cupboard");
  }
  if (t.includes("floor") || t.includes("carpet") || t.includes("tile")) {
    return pick("view-grid-outline", "view-grid");
  }
  if (t.includes("mold") || t.includes("mildew")) return pick("bacteria-outline", "bacteria");
  if (t.includes("mailbox") || (t.includes("mail") && t.includes("box"))) {
    return pick("mailbox-outline", "mailbox");
  }
  if (has("clog") || has("clogs") || has("clogged") || (has("drain") && has("blocked"))) {
    return "pipe-disconnected";
  }
  if (has("equipment") || (has("loaned") && has("tenant")) || (has("borrowed") && has("tenant"))) {
    return pick("toolbox-outline", "toolbox");
  }
  if (has("rodent") || has("rodents") || has("rat") || has("rats") || has("mouse") || has("mice")) {
    return "rodent";
  }

  for (const [needles, icon, activeIcon] of SUBSTRING_TABLE) {
    if (needles.every((n) => t.includes(n))) return pick(icon, activeIcon);
  }
  return pick("tag-outline", "tag");
}
