import { describe, expect, test } from "bun:test";
import type { WorkOrder } from "@/lib/api/work-orders";
import { buildClosedRows } from "@/lib/derived/closed-rows";
import {
  filterWorkOrders,
  matchesDisplayMode,
  normalizedOccupancyFilterValue,
  sortedTagOptions,
  WORK_ORDER_CLOSED_STATUSES,
  WORK_ORDER_OPEN_STATUSES,
} from "@/lib/derived/filtering";
import { buildOpenGroups } from "@/lib/derived/open-groups";
import { parseWorkOrder } from "@/lib/derived/parse";
import { sortOptionsFor, type WorkOrderSortOption } from "@/lib/derived/sort";
import {
  EMPTY_FILTERS,
  type ParsedWorkOrder,
  type UnitFacts,
  type UnitIndex,
} from "@/lib/derived/types";

// Fixed clock: all date fixtures use LOCAL datetime strings ("…T09:00:00",
// never date-only ISO, which Date.parse reads as UTC) so tests are
// timezone-independent.
const NOW = new Date("2026-07-18T12:00:00").getTime();

let seq = 0;

/** Fixture builder: minimal raw WorkOrder run through the real parser. */
function wo(overrides: Partial<WorkOrder> = {}): ParsedWorkOrder {
  seq += 1;
  return parseWorkOrder({
    resman_work_order_id: `wo-${seq}`,
    number: String(1000 + seq),
    unit_lease_group_id: "",
    resman_lease_id: "",
    unit_number: "101",
    status: "Open",
    priority: "Normal",
    category: "",
    title: "Leaky faucet",
    notes: "",
    completion_notes: "",
    technician: "",
    is_make_ready: false,
    callback_requested: false,
    callback_completed: false,
    tags: [],
    is_duplicate: false,
    callback_status: "none",
    callback_matched_work_order_id: "",
    callback_engine_version: "",
    callback_source: "",
    ...overrides,
  });
}

function facts(overrides: Partial<UnitFacts> & { unitNumber: string }): UnitFacts {
  return {
    classification: "",
    occupancyStatus: "",
    leaseStatus: "",
    availability: "",
    building: "",
    moveInAt: null,
    leaseStartAt: null,
    moveOutAt: null,
    tenantNames: [],
    ...overrides,
  };
}

function unitIndexOf(...all: UnitFacts[]): UnitIndex {
  return new Map(all.map((f) => [f.unitNumber, f]));
}

const EMPTY_INDEX: UnitIndex = new Map();

describe("matchesDisplayMode", () => {
  test("every open status is on the open board; closed statuses are not", () => {
    for (const status of WORK_ORDER_OPEN_STATUSES) {
      expect(matchesDisplayMode(wo({ status }), "open")).toBe(true);
      expect(matchesDisplayMode(wo({ status }), "closed")).toBe(false);
    }
  });

  test("both Cancelled and the synced Canceled spelling are closed", () => {
    for (const status of ["Closed", "Completed", "Cancelled", "Canceled"]) {
      expect(WORK_ORDER_CLOSED_STATUSES).toContain(status);
      expect(matchesDisplayMode(wo({ status }), "closed")).toBe(true);
      expect(matchesDisplayMode(wo({ status }), "open")).toBe(false);
    }
  });

  test("make-readies are excluded from open/closed/hotSpots and own the makeReady board", () => {
    const mr = wo({ status: "Open", is_make_ready: true });
    expect(matchesDisplayMode(mr, "open")).toBe(false);
    expect(matchesDisplayMode(mr, "hotSpots")).toBe(false);
    expect(matchesDisplayMode(mr, "makeReady")).toBe(true);
    const closedMr = wo({ status: "Completed", is_make_ready: true });
    expect(matchesDisplayMode(closedMr, "closed")).toBe(false);
    expect(matchesDisplayMode(closedMr, "makeReady")).toBe(true);
    // hotSpots takes any non-make-ready status.
    expect(matchesDisplayMode(wo({ status: "Completed" }), "hotSpots")).toBe(true);
  });

  test("make-ready CATEGORIES are folded into isMakeReady even when the flag is false", () => {
    // ResMan's report-level MakeReady flag misses these in prod (13/1,000 sampled).
    for (const category of [
      "Make Ready Maintenance",
      "Make Ready Not Complete",
      "Turn Maintenance/Punch",
      "Inspection and make ready",
    ]) {
      const leaked = wo({ status: "Completed", is_make_ready: false, category });
      expect(leaked.isMakeReady).toBe(true);
      expect(matchesDisplayMode(leaked, "closed")).toBe(false);
      expect(matchesDisplayMode(leaked, "makeReady")).toBe(true);
    }
    // Ordinary categories must NOT be swept in ("Return" contains "turn" but not as a word).
    for (const category of ["HVAC", "Plumbing", "Key Return", "General Maintenance"]) {
      expect(wo({ status: "Completed", is_make_ready: false, category }).isMakeReady).toBe(false);
    }
  });
});

describe("filterWorkOrders faceted counts", () => {
  const index = unitIndexOf(
    facts({ unitNumber: "101", classification: "Ruby" }),
    facts({ unitNumber: "202", classification: "Diamond" }),
  );
  const a = wo({
    unit_number: "101",
    status: "Open",
    technician: "Maintenance Team",
    callback_status: "possible",
  });
  const b = wo({ unit_number: "101", status: "In Progress", is_duplicate: true });
  const c = wo({ unit_number: "202", status: "Open", technician: "Zed" });
  const workOrders = [a, b, c];

  test("statusCounts ignore the active status filter; classificationCounts respect it", () => {
    const { filtered, panel } = filterWorkOrders({
      workOrders,
      mode: "open",
      search: "",
      filters: { ...EMPTY_FILTERS, status: ["Open"] },
      signalFilter: "all",
      unitIndex: index,
    });
    // Status facet counts as if the status filter were off…
    expect(panel.statusCounts).toEqual(
      new Map([
        ["Open", 2],
        ["In Progress", 1],
      ]),
    );
    // …but every other facet applies it: b (In Progress, Ruby) drops out.
    expect(panel.classificationCounts).toEqual(
      new Map([
        ["Ruby", 1],
        ["Diamond", 1],
      ]),
    );
    expect(panel.technicianCounts).toEqual(
      new Map([
        ["General Maintenance", 1],
        ["Zed", 1],
      ]),
    );
    // Signal counts apply all non-signal facets: only a's callback survives.
    expect(panel.signalCounts).toEqual(new Map([["Callback", 1]]));
    expect(panel.signalWorkOrderCount).toBe(1);
    expect(filtered.map((w) => w.id)).toEqual([a.id, c.id]);
    // Options come from mode+search only; "Unassigned" (b) is excluded.
    expect(panel.technicianOptions).toEqual(["General Maintenance", "Zed"]);
  });

  test("signal filter narrows the list and the status facet", () => {
    const { filtered, panel } = filterWorkOrders({
      workOrders,
      mode: "open",
      search: "",
      filters: EMPTY_FILTERS,
      signalFilter: "duplicates",
      unitIndex: index,
    });
    expect(filtered.map((w) => w.id)).toEqual([b.id]);
    expect(panel.statusCounts).toEqual(new Map([["In Progress", 1]]));
  });

  test("search matches the precomputed haystack", () => {
    const { filtered } = filterWorkOrders({
      workOrders,
      mode: "open",
      search: "  ZED ",
      filters: EMPTY_FILTERS,
      signalFilter: "all",
      unitIndex: index,
    });
    expect(filtered.map((w) => w.id)).toEqual([c.id]);
  });
});

describe("normalizedOccupancyFilterValue", () => {
  test("folds known spellings onto the canonical chips", () => {
    expect(normalizedOccupancyFilterValue(facts({ unitNumber: "1", occupancyStatus: " OCCUPIED " }))).toBe("Occupied");
    expect(normalizedOccupancyFilterValue(facts({ unitNumber: "1", occupancyStatus: "vacant" }))).toBe("Vacant");
    expect(normalizedOccupancyFilterValue(facts({ unitNumber: "1", occupancyStatus: "Under Eviction" }))).toBe("Eviction");
    expect(normalizedOccupancyFilterValue(facts({ unitNumber: "1", occupancyStatus: "eviction" }))).toBe("Eviction");
    expect(normalizedOccupancyFilterValue(facts({ unitNumber: "1", occupancyStatus: "Notice to Vacate" }))).toBe("NTV");
    expect(normalizedOccupancyFilterValue(facts({ unitNumber: "1", occupancyStatus: "ntv" }))).toBe("NTV");
    expect(normalizedOccupancyFilterValue(facts({ unitNumber: "1", occupancyStatus: " Model " }))).toBe("Model");
    expect(normalizedOccupancyFilterValue(undefined)).toBe("");
  });

  test("Notice disambiguates via lease status (the mirror files evictions under Notice)", () => {
    expect(
      normalizedOccupancyFilterValue(
        facts({ unitNumber: "1", occupancyStatus: "Notice", leaseStatus: "Under Eviction" }),
      ),
    ).toBe("Eviction");
    expect(
      normalizedOccupancyFilterValue(
        facts({ unitNumber: "1", occupancyStatus: "Notice", leaseStatus: "Notice to Vacate" }),
      ),
    ).toBe("NTV");
    expect(
      normalizedOccupancyFilterValue(
        facts({ unitNumber: "1", occupancyStatus: "Notice", leaseStatus: "Current" }),
      ),
    ).toBe("Notice");
  });
});

describe("sortedTagOptions", () => {
  test("curated order first, unknown tags after by case-insensitive name", () => {
    expect(sortedTagOptions(["Zebra", "HVAC", "alpha", "Clogs"])).toEqual([
      "HVAC",
      "Clogs",
      "alpha",
      "Zebra",
    ]);
  });
});

describe("buildOpenGroups", () => {
  function groupsOf(workOrders: ParsedWorkOrder[], unitIndex: UnitIndex = EMPTY_INDEX, option: WorkOrderSortOption = "dateReportedDescending") {
    return buildOpenGroups({ workOrders, option, unitIndex, nowMs: NOW });
  }

  test("topTags caps at 4, ties break by name, signals prefer callback over duplicate", () => {
    const [group] = groupsOf([
      wo({ tags: ["HVAC", "Leaks"] }),
      wo({ tags: ["HVAC", "Clogs"], callback_status: "possible" }),
      wo({ tags: ["Pests", "Leaks"], is_duplicate: true }),
      wo({ tags: ["Mold"] }),
    ]);
    expect(group.topTags.map((t) => t.tag)).toEqual(["HVAC", "Leaks", "Clogs", "Mold"]);
    expect(group.topTags.map((t) => t.count)).toEqual([2, 2, 1, 1]);
    expect(group.topTags[0].signal).toBe("callback"); // HVAC rides the callback wo
    expect(group.topTags[1].signal).toBe("duplicate"); // Leaks rides the duplicate wo
    expect(group.topTags[3].signal).toBe(null);
    expect(group.callbackWorkOrderIds).toHaveLength(1);
  });

  test("a possible-duplicate pair needs at least 2 duplicates in the group", () => {
    const [one] = groupsOf([wo({ is_duplicate: true }), wo({})]);
    expect(one.hasPossibleDuplicate).toBe(false);
    const [two] = groupsOf([wo({ is_duplicate: true }), wo({ is_duplicate: true })]);
    expect(two.hasPossibleDuplicate).toBe(true);
  });

  test("blank unit numbers group under Unassigned Unit", () => {
    const groups = groupsOf([wo({ unit_number: "" }), wo({ unit_number: "  " })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].unitNumber).toBe("Unassigned Unit");
    expect(groups[0].workOrders).toHaveLength(2);
  });

  test("timeline caps at 6 day-events and reports the overflow", () => {
    const days = ["01", "03", "05", "07", "09", "11", "13", "15"];
    const [group] = groupsOf(days.map((d) => wo({ date_reported: `2026-07-${d}T09:00:00` })));
    expect(group.timeline).toHaveLength(6);
    expect(group.timelineOverflow).toBe(2);
    // Oldest six kept, ascending.
    expect(group.timeline.map((e) => new Date(e.dayMs).getDate())).toEqual([1, 3, 5, 7, 9, 11]);
    // Rail spans oldest day → today (Jul 18): first at 0, later dots increasing.
    expect(group.timeline[0].position).toBe(0);
    for (let i = 1; i < group.timeline.length; i += 1) {
      expect(group.timeline[i].position).toBeGreaterThan(group.timeline[i - 1].position);
    }
    expect(group.timeline[5].position).toBeLessThan(1);
  });

  test("a lone same-day event sits at position 0.5", () => {
    const [group] = groupsOf([wo({ date_reported: "2026-07-18T08:00:00" })]);
    expect(group.timeline).toHaveLength(1);
    expect(group.timeline[0].position).toBe(0.5);
  });

  test("rail tint escalates at 7/14/30 days of oldest-issue age", () => {
    const tintFor = (dateReported: string) =>
      groupsOf([wo({ date_reported: dateReported })])[0].railTint;
    expect(tintFor("2026-07-12T09:00:00")).toBe("secondary"); // 6 days
    expect(tintFor("2026-07-11T09:00:00")).toBe("warning"); // exactly 7
    expect(tintFor("2026-07-05T09:00:00")).toBe("warning"); // 13
    expect(tintFor("2026-07-04T09:00:00")).toBe("attention"); // exactly 14
    expect(tintFor("2026-06-19T09:00:00")).toBe("attention"); // 29
    expect(tintFor("2026-06-18T09:00:00")).toBe("blocked"); // exactly 30
    expect(tintFor("2026-06-13T09:00:00")).toBe("blocked"); // 35
  });

  test("recent move-in marks the first qualifying event", () => {
    const index = unitIndexOf(
      facts({ unitNumber: "101", moveInAt: new Date("2026-07-06T00:00:00").getTime() }),
    );
    const [group] = groupsOf(
      [wo({ unit_number: "101", date_reported: "2026-07-08T09:00:00" })],
      index,
    );
    expect(group.moveIn).toEqual({
      dayMs: new Date("2026-07-06T00:00:00").getTime(),
      daysAgo: 12,
      position: 0,
    });
    expect(group.firstIssueAfterMoveIn).toEqual({ eventIndex: 0, elapsedDays: 2 });
    expect(group.timeline[0].isFirstIssueAfterMoveIn).toBe(true);
  });

  test("the rail starts at the move-in when the move-in came first", () => {
    // The ordinary case: resident moves in (Jul 6), reports a problem after
    // (Jul 8). A domain anchored on the first WORK ORDER put the move-in at a
    // negative position, which clamped onto the first dot — drawn, invisible,
    // and with a zero-width bridge to the issue it is supposed to connect to.
    const index = unitIndexOf(
      facts({ unitNumber: "101", moveInAt: new Date("2026-07-06T00:00:00").getTime() }),
    );
    const [group] = groupsOf(
      [wo({ unit_number: "101", date_reported: "2026-07-08T09:00:00" })],
      index,
    );
    expect(group.railStartMs).toBe(new Date("2026-07-06T00:00:00").getTime());
    expect(group.railEndMs).toBe(new Date("2026-07-18T00:00:00").getTime()); // today
    // Move-in anchors the left end; the issue sits inside the rail, not on it.
    expect(group.moveIn!.position).toBe(0);
    expect(group.timeline[0].position).toBeCloseTo(2 / 12, 5);
    expect(group.timeline[0].position).toBeGreaterThan(group.moveIn!.position);
  });

  test("a move-in AFTER the first issue leaves the domain alone", () => {
    // Turn work opened before the new resident arrived: the rail still starts at
    // the work, and the marker plots inside it.
    const index = unitIndexOf(
      facts({ unitNumber: "101", moveInAt: new Date("2026-07-10T00:00:00").getTime() }),
    );
    const [group] = groupsOf(
      [wo({ unit_number: "101", date_reported: "2026-07-04T09:00:00" })],
      index,
    );
    expect(group.railStartMs).toBe(new Date("2026-07-04T00:00:00").getTime());
    expect(group.timeline[0].position).toBe(0);
    expect(group.moveIn!.position).toBeCloseTo(6 / 14, 5);
  });

  test("no move-in leaves the domain at the first event", () => {
    const [group] = groupsOf([wo({ date_reported: "2026-07-08T09:00:00" })]);
    expect(group.moveIn).toBe(null);
    expect(group.railStartMs).toBe(new Date("2026-07-08T00:00:00").getTime());
    expect(group.timeline[0].position).toBe(0);
  });

  test("stale move-ins (>30 days ago) get no marker", () => {
    const index = unitIndexOf(
      facts({ unitNumber: "101", moveInAt: new Date("2026-06-01T00:00:00").getTime() }),
    );
    const [group] = groupsOf([wo({ unit_number: "101", date_reported: "2026-07-08T09:00:00" })], index);
    expect(group.moveIn).toBe(null);
    expect(group.firstIssueAfterMoveIn).toBe(null);
  });

  test("unitAscending orders groups numerically, not lexically", () => {
    const groups = groupsOf(
      [wo({ unit_number: "10" }), wo({ unit_number: "9" })],
      EMPTY_INDEX,
      "unitAscending",
    );
    expect(groups.map((g) => g.unitNumber)).toEqual(["9", "10"]);
  });
});

describe("buildClosedRows", () => {
  const w1 = wo({
    number: "9",
    unit_number: "12",
    status: "Closed",
    date_reported: "2026-07-01T09:00:00",
    date_completed: "2026-07-10T09:00:00",
  });
  const w2 = wo({
    number: "100",
    unit_number: "2",
    status: "Completed",
    date_reported: "2026-07-05T09:00:00",
    date_completed: "2026-07-06T09:00:00",
  });
  const w3 = wo({
    number: "20",
    unit_number: "101",
    status: "Canceled",
    date_completed: "2026-07-12T09:00:00",
  });
  const w4 = wo({
    number: "3",
    unit_number: "5",
    status: "Cancelled",
    date_reported: "2026-07-03T09:00:00",
  });
  const workOrders = [w1, w2, w3, w4];

  function numbersFor(option: WorkOrderSortOption): string[] {
    return buildClosedRows({ workOrders, option, unitIndex: EMPTY_INDEX, nowMs: NOW }).map(
      (r) => r.number,
    );
  }

  test("daysToComplete is -1 / em-dash when either date is missing", () => {
    const rows = buildClosedRows({
      workOrders,
      option: "unitAscending",
      unitIndex: EMPTY_INDEX,
      nowMs: NOW,
    });
    const byNumber = new Map(rows.map((r) => [r.number, r]));
    expect(byNumber.get("9")!.daysToComplete).toBe(9);
    expect(byNumber.get("9")!.daysToCompleteText).toBe("9");
    expect(byNumber.get("20")!.daysToComplete).toBe(-1); // no reported date
    expect(byNumber.get("20")!.daysToCompleteText).toBe("—");
    expect(byNumber.get("3")!.daysToComplete).toBe(-1); // no completed date
    expect(byNumber.get("3")!.daysToCompleteText).toBe("—");
    expect(byNumber.get("3")!.dateCompletedText).toBe("—");
    expect(byNumber.get("9")!.dateCompletedText).toBe("Jul 10");
    expect(byNumber.get("9")!.classification).toBe("—"); // unknown unit
  });

  test("every sort option orders the fixture as specified", () => {
    expect(numbersFor("dateCompletedDescending")).toEqual(["20", "9", "100", "3"]);
    expect(numbersFor("dateReportedDescending")).toEqual(["100", "3", "9", "20"]);
    expect(numbersFor("recentMoveInDescending")).toEqual(["100", "3", "9", "20"]); // falls back to reported
    expect(numbersFor("dateReportedAscending")).toEqual(["9", "3", "100", "20"]); // missing reported last
    expect(numbersFor("statusAscending")).toEqual(["20", "3", "9", "100"]); // Canceled<Cancelled<Closed<Completed
    expect(numbersFor("statusDescending")).toEqual(["100", "9", "3", "20"]);
    expect(numbersFor("unitAscending")).toEqual(["100", "3", "9", "20"]); // units 2,5,12,101
  });
});

describe("sortOptionsFor", () => {
  test("move-in sorting is offered only on the open board, both directions", () => {
    expect(sortOptionsFor("open")).toContain("recentMoveInDescending");
    expect(sortOptionsFor("open")).toContain("recentMoveInAscending");
    for (const mode of ["closed", "makeReady", "hotSpots"] as const) {
      expect(sortOptionsFor(mode)).not.toContain("recentMoveInDescending");
      expect(sortOptionsFor(mode)).not.toContain("recentMoveInAscending");
    }
  });

  test("completion sorting is offered only on the closed board", () => {
    // Open work has no completion date, so every row would share the missing-
    // date sentinel: a control that looks like it sorts and does not.
    expect(sortOptionsFor("closed")).toContain("dateCompletedDescending");
    expect(sortOptionsFor("closed")).toContain("dateCompletedAscending");
    for (const mode of ["open", "makeReady", "hotSpots"] as const) {
      expect(sortOptionsFor(mode)).not.toContain("dateCompletedDescending");
      expect(sortOptionsFor(mode)).not.toContain("dateCompletedAscending");
    }
  });

  test("each board offers four fields, or three where neither extra applies", () => {
    // 2 directions each. Retiring id sorting took a field off every board.
    expect(sortOptionsFor("open")).toHaveLength(8);
    expect(sortOptionsFor("closed")).toHaveLength(8);
    expect(sortOptionsFor("makeReady")).toHaveLength(6);
  });
});
