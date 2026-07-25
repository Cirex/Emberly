import { describe, expect, test } from "bun:test";
import {
  bandFor,
  buildClosedSections,
  groupsApplyTo,
  singleClosedSection,
} from "@/lib/derived/closed-sections";
import type { ClosedWorkOrderRow } from "@/lib/derived/closed-rows";

/**
 * Timeline bands for the closed board (2026-07-21 design pass).
 *
 * Two things are easy to get wrong and invisible when you do:
 *   - bands must be CALENDAR days, not rolling 24h windows. Something closed at
 *     11pm yesterday is "yesterday" to a person even though it is two hours ago;
 *     a 24h window would file it under Today.
 *   - bands only describe a list ordered BY DATE. Sorted by unit or id, a
 *     "TODAY · 6" header would sit above whichever rows happened to land there,
 *     and the count would be a lie.
 */

const NOW = Date.parse("2026-07-25T14:00:00");

function row(over: Partial<ClosedWorkOrderRow> = {}): ClosedWorkOrderRow {
  return {
    id: `wo-${Math.abs(over.dateCompletedMs ?? 0)}-${over.number ?? "x"}`,
    number: "1",
    status: "Completed",
    unitNumber: "0101",
    classification: "Ruby",
    title: "Faucet",
    dateCompletedText: "",
    dateCompletedMs: NOW,
    dateReportedMs: NOW,
    daysToComplete: 1,
    daysToCompleteText: "1",
    technicianDisplay: "Alex Rivera",
    technicianInitials: "AR",
    tradeTag: "Leaks",
    daysToCloseLabel: "1 day",
    isCallback: false,
    ...over,
  };
}

const at = (iso: string) => Date.parse(iso);

describe("closed timeline bands", () => {
  test("bands are calendar days, not rolling 24h windows", () => {
    // 11pm "yesterday" is 15 hours before NOW — inside 24h, but a different day.
    expect(bandFor(at("2026-07-24T23:00:00"), NOW)).toBe("thisWeek");
    // Just after midnight today is Today even though it is 14 hours ago.
    expect(bandFor(at("2026-07-25T00:05:00"), NOW)).toBe("today");
    // And later today, even if the clock says it is ahead of NOW.
    expect(bandFor(at("2026-07-25T23:30:00"), NOW)).toBe("today");
  });

  test("every band is reachable and they do not overlap", () => {
    expect(bandFor(at("2026-07-25T09:00:00"), NOW)).toBe("today");
    expect(bandFor(at("2026-07-20T09:00:00"), NOW)).toBe("thisWeek");
    expect(bandFor(at("2026-07-03T09:00:00"), NOW)).toBe("earlierThisMonth");
    expect(bandFor(at("2026-06-28T09:00:00"), NOW)).toBe("older");
    expect(bandFor(null, NOW)).toBe("undated");
  });

  test("the seven-day boundary belongs to exactly one band", () => {
    // Seven calendar days back is the first day NOT in "this week".
    expect(bandFor(at("2026-07-19T12:00:00"), NOW)).toBe("thisWeek");
    expect(bandFor(at("2026-07-18T12:00:00"), NOW)).toBe("earlierThisMonth");
  });

  test("grouping partitions without re-sorting or losing rows", () => {
    const rows = [
      row({ number: "a", dateCompletedMs: at("2026-07-25T10:00:00") }),
      row({ number: "b", dateCompletedMs: at("2026-07-25T09:00:00") }),
      row({ number: "c", dateCompletedMs: at("2026-07-21T09:00:00") }),
      row({ number: "d", dateCompletedMs: at("2026-07-02T09:00:00") }),
      row({ number: "e", dateCompletedMs: null }),
    ];
    const sections = buildClosedSections(rows, NOW);

    expect(sections.map((s) => s.key)).toEqual([
      "today",
      "thisWeek",
      "earlierThisMonth",
      "undated",
    ]);
    // Counts are what the header prints, so they must be the band's real size.
    expect(sections.map((s) => s.count)).toEqual([2, 1, 1, 1]);
    // Nothing dropped.
    expect(sections.reduce((n, s) => n + s.data.length, 0)).toBe(rows.length);
    // Caller order preserved inside a band — this partitions, never re-sorts.
    expect(sections[0].data.map((r) => r.number)).toEqual(["a", "b"]);
  });

  test("empty bands are dropped, not rendered as bare headers", () => {
    const sections = buildClosedSections([row({ dateCompletedMs: at("2026-06-01T09:00:00") })], NOW);
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe("older");
  });

  test("bands apply only to a date-completed ordering", () => {
    expect(groupsApplyTo("dateCompletedDescending")).toBe(true);
    expect(groupsApplyTo("dateCompletedAscending")).toBe(true);
    // These would put arbitrary rows under a day header.
    expect(groupsApplyTo("unitAscending")).toBe(false);
    expect(groupsApplyTo("unitDescending")).toBe(false);
    expect(groupsApplyTo("statusAscending")).toBe(false);
    // Reported-date is a date, but NOT the one the bands describe.
    expect(groupsApplyTo("dateReportedDescending")).toBe(false);
  });

  test("the ungrouped fallback still renders one list", () => {
    const rows = [row({ number: "a" }), row({ number: "b" })];
    const single = singleClosedSection(rows);
    expect(single).toHaveLength(1);
    expect(single[0].data).toHaveLength(2);
    // An empty board yields no section rather than an empty header.
    expect(singleClosedSection([])).toEqual([]);
  });
});
