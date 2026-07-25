import { describe, expect, test } from "bun:test";
import {
  MAPPED_PRIORITIES,
  MAPPED_STATUSES,
  PRIORITY_KEYS,
  STATUS_KEYS,
  RESMAN_LABELS,
  priorityLabel,
  statusLabel,
} from "@/lib/derived/resman-labels";

/**
 * ResMan's status and priority are a CLOSED set that appears on nearly every
 * row, so they get reviewed Spanish from the catalog rather than going through
 * the machine translator with the free prose. A Spanish-reading technician was
 * seeing "Not Started" and "In Progress" everywhere — My Day, the open board,
 * the make-ready board, hot spots and the detail chip — because every one of
 * those rendered the raw ResMan value.
 *
 * Two failure modes this guards:
 *   - a value in the mirror's CHECK constraint with no mapping (ships as raw
 *     English, silently);
 *   - a mapping whose catalog key does not exist (i18next echoes the key, so a
 *     technician sees "resman.status.inProgress" on screen).
 */

/** Real lookup against the loaded catalog, mirroring i18next's key echo. */
function translator(lang: "en" | "es") {
  return (key: string): string => {
    // Same shape i18n composes: the `resman` namespace IS RESMAN_LABELS[lang].
    const value = key
      .replace(/^resman\./, "")
      .split(".")
      .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], RESMAN_LABELS[lang]);
    return typeof value === "string" ? value : key;
  };
}

describe("ResMan enum labels", () => {
  test("every status the mirror allows has a mapping", () => {
    // RESMAN_WORK_ORDER_STATUSES is the same list as the DB CHECK constraint, so
    // a widened enum shows up here first.
    for (const status of MAPPED_STATUSES) {
      expect(STATUS_KEYS[status], `no key mapped for status "${status}"`).toBeDefined();
    }
  });

  test("every priority the mirror allows has a mapping", () => {
    for (const priority of MAPPED_PRIORITIES) {
      expect(PRIORITY_KEYS[priority], `no key mapped for priority "${priority}"`).toBeDefined();
    }
  });

  for (const lang of ["en", "es"] as const) {
    test(`${lang}: every mapped value resolves to real copy, never a key`, () => {
      const t = translator(lang);
      for (const status of Object.keys(STATUS_KEYS)) {
        const label = statusLabel(t, status);
        expect(label.startsWith("resman."), `status "${status}" showed a raw key`).toBe(false);
        expect(label.length).toBeGreaterThan(0);
      }
      for (const priority of Object.keys(PRIORITY_KEYS)) {
        const label = priorityLabel(t, priority);
        expect(label.startsWith("resman."), `priority "${priority}" showed a raw key`).toBe(false);
      }
    });
  }

  test("Spanish is actually different from English", () => {
    // A catalog copy-paste that left English in the es block would otherwise
    // pass every check above while showing a technician nothing new.
    const en = translator("en");
    const es = translator("es");
    const differing = MAPPED_STATUSES.filter((s) => statusLabel(en, s) !== statusLabel(es, s));
    expect(differing.length).toBe(MAPPED_STATUSES.length);
  });

  test("an unmapped value falls back to itself, not blank and not a key", () => {
    // ResMan can widen the set at any time; the wire types are string-tolerant
    // for exactly this reason, and the UI must degrade to showing the raw value.
    const t = translator("es");
    expect(statusLabel(t, "On Hold")).toBe("On Hold");
    expect(priorityLabel(t, "Critical")).toBe("Critical");
    expect(statusLabel(t, "")).toBe("");
  });

  test("both spellings of cancelled map to one label", () => {
    // ResMan's own reports have used the British spelling in places.
    const t = translator("es");
    expect(statusLabel(t, "Canceled")).toBe(statusLabel(t, "Cancelled"));
  });

  test("surrounding whitespace does not defeat the lookup", () => {
    const t = translator("es");
    expect(statusLabel(t, "  In Progress  ")).toBe(statusLabel(t, "In Progress"));
  });
});
