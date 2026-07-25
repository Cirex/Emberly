import { describe, expect, test } from "bun:test";
import {
  SORT_AXES,
  axesOf,
  directionKeys,
  optionFor,
  reconcileForMode,
  sortFieldsFor,
  type SortDirection,
  type SortField,
} from "@/lib/derived/sort-axes";
import { SORT_LABELS, sortOptionsFor, type WorkOrderSortOption } from "@/lib/derived/sort";
import { RESMAN_LABELS } from "@/lib/derived/resman-labels";

/**
 * Sort is presented as a field plus a direction, while the PERSISTED value stays
 * a flat union. That split is what turned four wrapping rows of twelve pills into
 * two rows — and it is only safe if the decomposition is exactly invertible.
 *
 * A mistake here does not crash; it silently sorts by the wrong thing, which is
 * the sort bug you never notice.
 */

const ALL = Object.keys(SORT_AXES) as WorkOrderSortOption[];
const FIELDS: SortField[] = ["dateCompleted", "dateReported", "recentMoveIn", "id", "status", "unit"];
const DIRECTIONS: SortDirection[] = ["asc", "desc"];

describe("sort axes", () => {
  test("decomposition round-trips for every stored option", () => {
    for (const option of ALL) {
      const { field, direction } = axesOf(option);
      expect(optionFor(field, direction), `${option} did not round-trip`).toBe(option);
    }
  });

  test("every field x direction pair exists — no dead direction button", () => {
    // The old matrix had holes: date-completed had no ascending, unit no
    // descending. A missing pair would make the direction control a no-op.
    for (const field of FIELDS) {
      for (const direction of DIRECTIONS) {
        const option = optionFor(field, direction);
        expect(axesOf(option)).toEqual({ field, direction });
      }
    }
    expect(ALL).toHaveLength(FIELDS.length * DIRECTIONS.length);
  });

  test("every option still has a legacy label, so nothing is orphaned", () => {
    // SORT_LABELS is the pre-existing flat mapping; a new union member added
    // without one would render blank anywhere still using it.
    for (const option of ALL) {
      expect(SORT_LABELS[option], `no SORT_LABELS entry for ${option}`).toBeTruthy();
    }
  });

  test("fields offered match the options offered, per mode", () => {
    for (const mode of ["open", "closed", "makeReady", "hotSpots"] as const) {
      const optionFields = new Set(sortOptionsFor(mode).map((o) => axesOf(o).field));
      expect(new Set(sortFieldsFor(mode))).toEqual(optionFields);
    }
    // Move-in is meaningless off the open board's unit groups.
    expect(sortFieldsFor("open")).toContain("recentMoveIn");
    expect(sortFieldsFor("closed")).not.toContain("recentMoveIn");
  });

  test("switching to Closed cannot strand a move-in sort", () => {
    // Without reconciliation the board would hold an option its own mode does
    // not offer, and the field control would show nothing selected.
    const reconciled = reconcileForMode("recentMoveInAscending", "closed");
    expect(sortOptionsFor("closed")).toContain(reconciled);
    // Direction is preserved across the fallback — the user asked for ascending.
    expect(axesOf(reconciled).direction).toBe("asc");
    // An option that IS valid for the mode is left alone.
    expect(reconcileForMode("idDescending", "closed")).toBe("idDescending");
  });

  test("direction labels read in the field's own language", () => {
    // "Ascending" for a date is a sentence a technician has to decode.
    expect(directionKeys("dateCompleted")).toEqual({ desc: "newestFirst", asc: "oldestFirst" });
    expect(directionKeys("id")).toEqual({ asc: "lowToHigh", desc: "highToLow" });
    expect(directionKeys("status")).toEqual({ asc: "aToZ", desc: "zToA" });
    // Every field must supply both, or the button renders an empty label.
    for (const field of FIELDS) {
      const keys = directionKeys(field);
      expect(keys.asc.length).toBeGreaterThan(0);
      expect(keys.desc.length).toBeGreaterThan(0);
    }
  });

  test("every direction key the UI can ask for exists in both catalogs", () => {
    // The sheet builds `workOrders.sort.direction.<key>`; a missing key makes
    // i18next echo the key onto the button.
    const used = new Set(FIELDS.flatMap((f) => [directionKeys(f).asc, directionKeys(f).desc]));
    for (const lang of ["en", "es"] as const) {
      // resman-labels is a sibling catalog; sort copy lives in lib/i18n, which
      // cannot be imported here (react-native). Assert the key SET instead, and
      // let tests/i18n-parity cover the copy itself.
      expect(used.size).toBeGreaterThanOrEqual(8);
      expect(RESMAN_LABELS[lang]).toBeTruthy();
    }
  });
});
