import { describe, expect, test } from "bun:test";

import { WorkOrderSchema, type WorkOrder } from "@/lib/api/work-orders";
import { buildCallbackAnalytics } from "@/lib/derived/callbacks";
import { buildClosedInsights } from "@/lib/derived/closed-insights";
import { buildDaysToCloseDistribution } from "@/lib/derived/days-to-close";
import type { HotSpotRow } from "@/lib/derived/hot-spots";
import { buildMakeReadyGroups } from "@/lib/derived/make-ready";
import { buildMonthlyClassification } from "@/lib/derived/monthly-classification";
import { parseWorkOrder } from "@/lib/derived/parse";
import { buildSameWeekTimeline } from "@/lib/derived/same-week-timeline";
import { buildScoreCards } from "@/lib/derived/score-cards";
import {
  buildMonthlyTechnicianSummary,
  buildWeeklyTechnicianSummary,
} from "@/lib/derived/technician-summary";
import { DAY_MS } from "@/lib/derived/time";
import type { ParsedWorkOrder, UnitFacts, UnitIndex } from "@/lib/derived/types";

/**
 * Fixed clock: Wednesday 2026-07-15 noon LOCAL time, so every week boundary in
 * the assertions is knowable — Monday week start = Jul 13, previous completed
 * week = Jul 6, 90-day cutoff = Apr 16 (whose Monday is Apr 13).
 */
const NOW = new Date("2026-07-15T12:00:00").getTime();

const localMs = (s: string) => new Date(s).getTime();

let seq = 0;
/** Minimal raw row through the real schema + parser, so fixtures share prod parsing. */
function makeWo(raw: Partial<WorkOrder> = {}): ParsedWorkOrder {
  seq += 1;
  return parseWorkOrder(
    WorkOrderSchema.parse({
      resman_work_order_id: `wo-${seq}`,
      number: `${1000 + seq}`,
      unit_number: "101",
      status: "Completed",
      technician: "Alice",
      ...raw,
    }),
  );
}

function makeFacts(unitNumber: string, overrides: Partial<UnitFacts> = {}): UnitFacts {
  return {
    unitNumber,
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

function makeHotSpotRow(overrides: Partial<HotSpotRow> = {}): HotSpotRow {
  return {
    unitNumber: "101",
    classification: "Ruby",
    score: 0,
    riskLevel: "Monitor",
    totalCount: 0,
    recentCount: 0,
    openCount: 0,
    callbackCount: 0,
    duplicateCount: 0,
    oldestOpenDays: null,
    occupiedDaysText: null,
    sinceLabel: "Since Move In",
    lastActivityMs: null,
    detail: [],
    callbackDetail: [],
    duplicateDetail: [],
    ...overrides,
  };
}

/** Closed row taking exactly `days` whole days to complete. */
function closedInDays(days: number, raw: Partial<WorkOrder> = {}): ParsedWorkOrder {
  const reported = localMs("2026-05-01T08:00:00");
  return makeWo({
    status: "Closed",
    date_reported: new Date(reported).toISOString(),
    date_completed: new Date(reported + days * DAY_MS).toISOString(),
    ...raw,
  });
}

// ── days-to-close ───────────────────────────────────────────────────────────

describe("buildDaysToCloseDistribution", () => {
  test("buckets are inclusive at the 2/3, 14/15, and 30/31 boundaries", () => {
    const { buckets, metrics } = buildDaysToCloseDistribution([
      closedInDays(2),
      closedInDays(3),
      closedInDays(14),
      closedInDays(15),
      closedInDays(30),
      closedInDays(31),
      // Missing either date → not counted.
      makeWo({ status: "Closed", date_reported: "2026-05-01T08:00:00", date_completed: null }),
      makeWo({ status: "Closed", date_reported: null, date_completed: "2026-05-04T08:00:00" }),
    ]);
    expect(buckets.map((b) => b.key)).toEqual(["0-2", "3-7", "8-14", "15-30", "31+"]);
    expect(buckets.map((b) => b.count)).toEqual([1, 1, 1, 2, 1]);
    expect(buckets.map((b) => b.caption)).toEqual([
      "Closed within 2 days",
      "Closed in 3 to 7 days",
      "Closed in 8 to 14 days",
      "Closed in 15 to 30 days",
      "Closed in 31 or more days",
    ]);
    expect(metrics.totalClosed).toBe(6);
    expect(metrics.dominantBucket?.key).toBe("15-30");
  });

  test("dominant bucket tie goes to the FIRST bucket", () => {
    const { metrics } = buildDaysToCloseDistribution([
      closedInDays(1),
      closedInDays(2),
      closedInDays(4),
      closedInDays(5),
    ]);
    expect(metrics.dominantBucket?.key).toBe("0-2");
  });

  test("empty input still emits all five zero-filled buckets", () => {
    const { buckets, metrics } = buildDaysToCloseDistribution([]);
    expect(buckets).toHaveLength(5);
    expect(buckets.every((b) => b.count === 0)).toBe(true);
    expect(metrics.totalClosed).toBe(0);
    expect(metrics.dominantBucket).toBeNull();
  });
});

// ── same-week timeline ──────────────────────────────────────────────────────

describe("buildSameWeekTimeline", () => {
  const fixtures = [
    // Week of Jun 22: one same-week close (2 days) + one carry-over (13 days).
    makeWo({ status: "Closed", date_reported: "2026-06-22T09:00:00", date_completed: "2026-06-24T09:00:00" }),
    makeWo({ status: "Closed", date_reported: "2026-06-10T09:00:00", date_completed: "2026-06-23T09:00:00" }),
    // Week of Jul 6: same-day close.
    makeWo({ status: "Closed", date_reported: "2026-07-08T09:00:00", date_completed: "2026-07-08T15:00:00" }),
    // Current (incomplete) week → excluded.
    makeWo({ status: "Closed", date_reported: "2026-07-13T09:00:00", date_completed: "2026-07-14T09:00:00" }),
    // Before the cutoff week → excluded.
    makeWo({ status: "Closed", date_reported: "2026-04-01T09:00:00", date_completed: "2026-04-10T09:00:00" }),
  ];

  test("emits one point per week from the cutoff week through last completed week", () => {
    const { points } = buildSameWeekTimeline(fixtures, NOW);
    expect(points).toHaveLength(13); // Mon Apr 13 … Mon Jul 6 inclusive.
    expect(points[0].weekStartMs).toBe(localMs("2026-04-13T00:00:00"));
    expect(points[points.length - 1].weekStartMs).toBe(localMs("2026-07-06T00:00:00"));
  });

  test("zero-fills gap weeks and excludes the current week", () => {
    const { points } = buildSameWeekTimeline(fixtures, NOW);
    const byWeek = new Map(points.map((p) => [p.weekStartMs, p]));

    const jun22 = byWeek.get(localMs("2026-06-22T00:00:00"))!;
    expect(jun22.totalClosedCount).toBe(2);
    expect(jun22.sameWeekClosedCount).toBe(1);
    expect(jun22.averageDaysToClose).toBeCloseTo(7.5); // (2 + 13) / 2
    expect(jun22.sameWeekCloseRate).toBeCloseTo(0.5);

    // Gap week between the two active weeks is present but zeroed.
    const jun29 = byWeek.get(localMs("2026-06-29T00:00:00"))!;
    expect(jun29.totalClosedCount).toBe(0);
    expect(jun29.sameWeekCloseRate).toBe(0);
    expect(jun29.averageDaysToClose).toBe(0);

    const jul6 = byWeek.get(localMs("2026-07-06T00:00:00"))!;
    expect(jul6.totalClosedCount).toBe(1);
    expect(jul6.sameWeekClosedCount).toBe(1);

    // The Jul 14 close never lands anywhere (current week excluded).
    expect(byWeek.has(localMs("2026-07-13T00:00:00"))).toBe(false);
  });

  test("metrics aggregate the counted closes only", () => {
    const { metrics } = buildSameWeekTimeline(fixtures, NOW);
    expect(metrics.totalClosed).toBe(3);
    expect(metrics.totalSameWeek).toBe(2);
    expect(metrics.overallRate).toBeCloseTo(2 / 3);
    expect(metrics.averageDaysToClose).toBeCloseTo(5); // (2 + 13 + 0) / 3
    expect(metrics.latestClosedWeekMs).toBe(localMs("2026-07-06T00:00:00"));
  });

  test("no closes → zero metrics and null latest week", () => {
    const { metrics } = buildSameWeekTimeline([], NOW);
    expect(metrics.totalClosed).toBe(0);
    expect(metrics.overallRate).toBe(0);
    expect(metrics.averageDaysToClose).toBe(0);
    expect(metrics.latestClosedWeekMs).toBeNull();
  });
});

// ── technician summaries ────────────────────────────────────────────────────

describe("buildWeeklyTechnicianSummary", () => {
  const fixtures = [
    makeWo({ status: "Completed", technician: "Alice", date_completed: "2026-07-13T10:00:00" }), // Monday → col 0
    makeWo({ status: "Completed", technician: "Alice", date_completed: "2026-07-19T22:00:00" }), // Sunday → col 6
    makeWo({ status: "Completed", technician: "Bob", date_completed: "2026-07-15T09:00:00" }), // Wed → col 2
    makeWo({ status: "Completed", technician: "Bob", date_completed: "2026-07-16T09:00:00" }), // Thu → col 3
    makeWo({ status: "Completed", technician: "", date_completed: "2026-07-14T09:00:00" }), // Unassigned → col 1
    makeWo({ status: "Completed", technician: "Alice", date_completed: "2026-07-12T23:00:00" }), // prior Sunday → out
    makeWo({ status: "Completed", technician: "Alice", date_completed: "2026-07-20T00:00:00" }), // next Monday → out
  ];

  test("buckets Monday-anchored days, including a Sunday close in column 6", () => {
    const summary = buildWeeklyTechnicianSummary(fixtures, NOW);
    expect(summary.columnLabels).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]);
    expect(summary.rows.map((r) => r.technician)).toEqual(["Alice", "Bob", "Unassigned"]);
    const alice = summary.rows[0];
    expect(alice.counts).toEqual([1, 0, 0, 0, 0, 0, 1]);
    expect(alice.averagePerPeriod).toBeCloseTo(2 / 7);
    expect(summary.columnTotals).toEqual([1, 1, 1, 1, 0, 0, 1]);
    expect(summary.columnMaxima).toEqual([1, 1, 1, 1, 0, 0, 1]);
    expect(summary.totalCompleted).toBe(5);
    expect(summary.averagePerTechnician).toBeCloseTo(5 / 7 / 3);
  });

  test("leaders include every technician tied at the max total", () => {
    const summary = buildWeeklyTechnicianSummary(fixtures, NOW);
    expect(summary.leaders).toEqual(["Alice", "Bob"]);
  });

  test("no completions → empty rows and leaders", () => {
    const summary = buildWeeklyTechnicianSummary([], NOW);
    expect(summary.rows).toEqual([]);
    expect(summary.leaders).toEqual([]);
    expect(summary.averagePerTechnician).toBe(0);
  });
});

describe("buildMonthlyTechnicianSummary", () => {
  test("buckets rolling 4 weeks with edge days landing correctly", () => {
    const summary = buildMonthlyTechnicianSummary(
      [
        makeWo({ status: "Completed", technician: "Alice", date_completed: "2026-06-22T00:30:00" }), // day 0 → col 0
        makeWo({ status: "Completed", technician: "Alice", date_completed: "2026-06-29T08:00:00" }), // day 7 → col 1
        makeWo({ status: "Completed", technician: "Alice", date_completed: "2026-07-19T10:00:00" }), // day 27 → col 3
        makeWo({ status: "Completed", technician: "Alice", date_completed: "2026-06-21T10:00:00" }), // day -1 → skipped
      ],
      NOW,
    );
    expect(summary.columnLabels).toEqual([
      "Jun 22 – Jun 28",
      "Jun 29 – Jul 5",
      "Jul 6 – Jul 12",
      "Jul 13 – Jul 19",
    ]);
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0].counts).toEqual([1, 1, 0, 1]);
    expect(summary.rows[0].averagePerPeriod).toBeCloseTo(3 / 4);
    expect(summary.totalCompleted).toBe(3);
  });
});

// ── monthly classification ──────────────────────────────────────────────────

describe("buildMonthlyClassification", () => {
  const unitIndex: UnitIndex = new Map([
    ["101", makeFacts("101", { classification: "Ruby" })],
    ["202", makeFacts("202", { classification: "Diamond" })],
    ["303", makeFacts("303", { classification: "Legacy" })],
    ["404", makeFacts("404", { classification: "Lux" })],
  ]);

  const fixtures = [
    // July: Ruby open + Diamond same-week close.
    makeWo({ unit_number: "101", status: "Open", date_reported: "2026-07-02T09:00:00", date_completed: null }),
    makeWo({
      unit_number: "202",
      status: "Completed",
      date_reported: "2026-07-06T09:00:00",
      date_completed: "2026-07-08T09:00:00",
    }),
    // Untracked statuses still count same-week when the classification is tracked.
    makeWo({
      unit_number: "101",
      status: "Weird",
      date_reported: "2026-07-06T09:00:00",
      date_completed: "2026-07-07T09:00:00",
    }),
    // Lux and unknown units never count.
    makeWo({ unit_number: "404", status: "Open", date_reported: "2026-07-03T09:00:00", date_completed: null }),
    makeWo({ unit_number: "505", status: "Open", date_reported: "2026-07-03T09:00:00", date_completed: null }),
    // Make-ready rows are filtered out defensively.
    makeWo({ unit_number: "101", status: "Open", date_reported: "2026-07-04T09:00:00", is_make_ready: true }),
    // June: Legacy carry-over close + Ruby open → volume 2 (ties July).
    makeWo({
      unit_number: "303",
      status: "Closed",
      date_reported: "2026-06-10T09:00:00",
      date_completed: "2026-06-25T09:00:00",
    }),
    makeWo({ unit_number: "101", status: "In Progress", date_reported: "2026-06-12T09:00:00", date_completed: null }),
    // February: lone Ruby open.
    makeWo({ unit_number: "101", status: "Open", date_reported: "2026-02-05T09:00:00", date_completed: null }),
  ];

  test("emits six months ascending and counts only tracked classifications", () => {
    const { months } = buildMonthlyClassification({ workOrders: fixtures, unitIndex, nowMs: NOW });
    expect(months.map((m) => m.monthLabel)).toEqual([
      "Feb 2026",
      "Mar 2026",
      "Apr 2026",
      "May 2026",
      "Jun 2026",
      "Jul 2026",
    ]);

    const july = months[5];
    expect(july.openCounts).toEqual({ Ruby: 1, Diamond: 0, Legacy: 0 });
    expect(july.closedCounts).toEqual({ Ruby: 0, Diamond: 1, Legacy: 0 });
    expect(july.totalOpenCount).toBe(1); // Lux/unknown/make-ready excluded
    expect(july.totalClosedCount).toBe(1);
    expect(july.sameWeekCompletedCount).toBe(2); // Diamond close + "Weird" tracked row

    const june = months[4];
    expect(june.openCounts.Ruby).toBe(1);
    expect(june.closedCounts.Legacy).toBe(1);
    expect(june.sameWeekCompletedCount).toBe(0);
  });

  test("busiest month tie goes to the FIRST (oldest) month", () => {
    const { metrics } = buildMonthlyClassification({ workOrders: fixtures, unitIndex, nowMs: NOW });
    expect(metrics.totalOpen).toBe(3);
    expect(metrics.totalClosed).toBe(2);
    // June and July both have volume 2 → June (earlier) wins.
    expect(metrics.busiestMonthLabel).toBe("Jun 2026");
  });

  test("no activity → null busiest month", () => {
    const { metrics } = buildMonthlyClassification({ workOrders: [], unitIndex, nowMs: NOW });
    expect(metrics.busiestMonthLabel).toBeNull();
  });
});

// ── callbacks ───────────────────────────────────────────────────────────────

describe("buildCallbackAnalytics", () => {
  const fixtures: ParsedWorkOrder[] = [
    // Alice's completed originals.
    makeWo({
      resman_work_order_id: "o1",
      number: "2001",
      status: "Completed",
      technician: "Alice",
      unit_number: "101",
      date_completed: "2026-07-01T10:00:00",
    }),
    makeWo({ status: "Completed", technician: "Alice", date_completed: "2026-06-15T10:00:00" }),
    // Ben Bloch's completed original.
    makeWo({
      resman_work_order_id: "o2",
      number: "2002",
      status: "Closed",
      technician: "Ben Bloch",
      unit_number: "303",
      date_completed: "2026-07-03T10:00:00",
    }),
    // Blank raw technician → excluded from completion denominators.
    makeWo({ status: "Completed", technician: "", date_completed: "2026-07-02T10:00:00" }),
    // Dave: 12 completions → not a small sample.
    ...Array.from({ length: 12 }, () =>
      makeWo({ status: "Completed", technician: "Dave", date_completed: "2026-06-01T10:00:00" }),
    ),
    // c1: matched to Alice's o1 → attributed to Alice, gap 4.
    makeWo({
      resman_work_order_id: "c1",
      number: "3001",
      status: "Open",
      technician: "Bob",
      unit_number: "101",
      callback_status: "confirmed",
      callback_matched_work_order_id: "o1",
      date_reported: "2026-07-05T10:00:00",
    }),
    // c2: unmatched + closed → falls to its own technician, null gap.
    makeWo({
      resman_work_order_id: "c2",
      number: "3002",
      status: "Cancelled",
      technician: "Carol",
      unit_number: "202",
      callback_status: "possible",
      date_reported: "2026-07-02T10:00:00",
    }),
    // Dismissed → excluded entirely.
    makeWo({ status: "Open", technician: "Bob", callback_status: "dismissed", date_reported: "2026-07-05T10:00:00" }),
    // c4: matched to Ben Bloch's o2 → detail kept, metrics excluded; gap 2.
    makeWo({
      resman_work_order_id: "c4",
      number: "3003",
      status: "Open",
      technician: "Dan",
      unit_number: "303",
      callback_status: "confirmed",
      callback_matched_work_order_id: "o2",
      date_reported: "2026-07-05T10:00:00",
    }),
    // c5: unmatched in-progress → Dave's own.
    makeWo({
      resman_work_order_id: "c5",
      number: "3004",
      status: "In Progress",
      technician: "Dave",
      unit_number: "150",
      callback_status: "possible",
      date_reported: "2026-07-06T10:00:00",
    }),
    // Eve pair: same rank, no gaps → numeric unit sort decides ("9" before "10").
    makeWo({ resman_work_order_id: "c6", number: "4001", status: "Open", technician: "Eve", unit_number: "9", callback_status: "possible" }),
    makeWo({ resman_work_order_id: "c7", number: "4002", status: "Open", technician: "Eve", unit_number: "10", callback_status: "possible" }),
  ];

  test("attribution, gaps, exclusions, and rates", () => {
    const analytics = buildCallbackAnalytics({ workOrders: fixtures, nowMs: NOW });

    expect(analytics.callbackTotal).toBe(6);
    expect(analytics.completedBase).toBe(15); // o1 + Alice#2 + o2 + Dave×12; blank tech skipped

    const c1 = analytics.details.find((d) => d.callbackId === "c1")!;
    expect(c1.technician).toBe("Alice"); // original's technician, not Bob
    expect(c1.originalId).toBe("o1");
    expect(c1.originalNumber).toBe("2001");
    expect(c1.gapDays).toBe(4);
    expect(c1.isOpen).toBe(true);

    const c2 = analytics.details.find((d) => d.callbackId === "c2")!;
    expect(c2.technician).toBe("Carol");
    expect(c2.originalId).toBeNull();
    expect(c2.gapDays).toBeNull();
    expect(c2.isOpen).toBe(false);

    // Ben Bloch: detail kept, metric excluded.
    const c4 = analytics.details.find((d) => d.callbackId === "c4")!;
    expect(c4.technician).toBe("Ben Bloch");
    expect(c4.gapDays).toBe(2);
    expect(analytics.metrics.find((m) => m.technician === "Ben Bloch")).toBeUndefined();
    expect(analytics.detailsByTechnician.get("Ben Bloch")!.map((d) => d.callbackId)).toEqual(["c4"]);

    // Dismissed candidate never appears.
    expect(analytics.details.some((d) => d.callbackStatus === "dismissed")).toBe(false);

    const alice = analytics.metrics.find((m) => m.technician === "Alice")!;
    expect(alice.callbackCount).toBe(1);
    expect(alice.completedCount).toBe(2);
    expect(alice.callbackRate).toBeCloseTo(0.5);
    expect(alice.hasSmallSample).toBe(true);

    const dave = analytics.metrics.find((m) => m.technician === "Dave")!;
    expect(dave.completedCount).toBe(12);
    expect(dave.callbackRate).toBeCloseTo(1 / 12);
    expect(dave.hasSmallSample).toBe(false);

    const carol = analytics.metrics.find((m) => m.technician === "Carol")!;
    expect(carol.completedCount).toBe(0);
    expect(carol.callbackRate).toBe(0);
    expect(carol.hasSmallSample).toBe(true);
  });

  test("metric and detail sort orders", () => {
    const analytics = buildCallbackAnalytics({ workOrders: fixtures, nowMs: NOW });

    // rate desc → callbackCount desc (Eve 2 > Carol 1 at rate 0).
    expect(analytics.metrics.map((m) => m.technician)).toEqual(["Alice", "Dave", "Eve", "Carol"]);
    expect(analytics.highestRate?.technician).toBe("Alice");

    // Open first (closed c2 sinks last); Open-rank before In Progress;
    // gap asc (null last); unit numeric ("9" before "10").
    expect(analytics.details.map((d) => d.callbackId)).toEqual(["c4", "c1", "c6", "c7", "c5", "c2"]);
  });
});

// ── score cards ─────────────────────────────────────────────────────────────

describe("buildScoreCards", () => {
  const emptyWeekly = buildWeeklyTechnicianSummary([], NOW);

  function cards(input: Partial<Parameters<typeof buildScoreCards>[0]> & { mode: "open" | "closed" | "makeReady" | "hotSpots" }) {
    return buildScoreCards({
      visible: [],
      openFiltered: [],
      closedFiltered: [],
      allNonMakeReady: [],
      makeReadyGroups: [],
      hotSpotRows: [],
      weeklySummary: emptyWeekly,
      nowMs: NOW,
      ...input,
    });
  }

  test("open mode: titles, submitted percent (2dp), aging caption, callbacks", () => {
    const open = [
      makeWo({ status: "Open", unit_number: "101", date_reported: "2026-07-05T09:00:00", date_completed: null }),
      makeWo({ status: "Open", unit_number: "101", date_reported: "2026-07-14T09:00:00", date_completed: null }),
      makeWo({ status: "Open", unit_number: "202", date_reported: null, callback_status: "confirmed" }),
    ];
    const submitted = [
      makeWo({ status: "Completed", date_reported: "2026-07-02T09:00:00", date_completed: "2026-07-04T09:00:00" }),
      makeWo({ status: "Open", date_reported: "2026-07-06T09:00:00", date_completed: null }),
      makeWo({ status: "Open", date_reported: "2026-06-20T09:00:00", date_completed: null }), // last month
    ];
    const result = cards({ mode: "open", visible: open, openFiltered: open, allNonMakeReady: submitted });

    expect(result.map((c) => c.title)).toEqual(["Open work orders", "Submitted in month", "Aging risk", "Callbacks"]);
    expect(result.map((c) => c.interactive)).toEqual([true, false, false, true]);
    expect(result[0].value).toBe("3");
    expect(result[0].caption).toBe("2 units with open work");
    expect(result[0].action).toBe("openMonthly");
    expect(result[1].value).toBe("2");
    expect(result[1].caption).toBe("50.00% completed");
    // Ages to start of Jul 15: 10 days and 1 day → one aging (≥8), avg 5.5.
    expect(result[2].value).toBe("1");
    expect(result[2].caption).toBe("Oldest 10 days, avg 5.5 days open");
    expect(result[3].value).toBe("1");
    expect(result[3].caption).toBe("1 open ticket matches completed work");
    expect(result[3].action).toBe("callbacks");
  });

  test("open mode aging edge captions: near-1 average and no dated rows", () => {
    const oneDay = [makeWo({ status: "Open", date_reported: "2026-07-14T09:00:00", date_completed: null })];
    expect(cards({ mode: "open", visible: oneDay, openFiltered: oneDay })[2].caption).toBe(
      "Oldest 1 day, avg 1 day open",
    );

    const undated = [makeWo({ status: "Open", date_reported: null, date_completed: null })];
    expect(cards({ mode: "open", visible: undated, openFiltered: undated })[2].caption).toBe(
      "No dated open work orders",
    );
    expect(cards({ mode: "open" })[3].caption).toBe("No callback candidates in view");
  });

  test("closed mode: same-week window, averages, and technician captions", () => {
    const closed = [
      makeWo({ status: "Closed", technician: "Bob", date_reported: "2026-06-22T09:00:00", date_completed: "2026-06-24T09:00:00" }),
      makeWo({ status: "Closed", technician: "Bob", date_reported: "2026-06-10T09:00:00", date_completed: "2026-06-23T09:00:00" }),
      makeWo({ status: "Closed", technician: "Alice", date_reported: "2026-07-13T09:00:00", date_completed: "2026-07-14T09:00:00" }),
      makeWo({ status: "Closed", technician: "", date_reported: "2026-07-08T09:00:00", date_completed: "2026-07-08T15:00:00" }),
    ];
    const weekly = buildWeeklyTechnicianSummary(closed, NOW);
    const result = cards({ mode: "closed", visible: closed, closedFiltered: closed, weeklySummary: weekly });

    expect(result.map((c) => c.title)).toEqual([
      "Closed same week",
      "Avg days to close",
      "Closed this week",
      "Closed this month",
    ]);
    expect(result.every((c) => c.interactive)).toBe(true);
    expect(result.map((c) => c.action)).toEqual(["sameWeek", "daysToClose", "technicianWeek", "technicianMonth"]);

    // Sample excludes the current-week close: 3 tickets, 2 same-week.
    expect(result[0].value).toBe("2");
    expect(result[0].caption).toBe("66.7% of 3 tickets in 90 days");
    // (2 + 13 + 1 + 0) / 4 = 4.0 across all four dated closes.
    expect(result[1].value).toBe("4.0");
    expect(result[1].caption).toBe("Across 4 closed work orders");
    // Only the Jul 14 close is in the current week; weekly grid has 1 row.
    expect(result[2].value).toBe("1");
    expect(result[2].caption).toBe("Avg 1.0 per technician");
    // July closes: Jul 14 (Alice) + Jul 8 (Unassigned) → 2 over 1 named tech.
    expect(result[3].value).toBe("2");
    expect(result[3].caption).toBe("Avg 2.0 per technician");
  });

  test("closed mode zero branches use the no-completions copy", () => {
    const result = cards({ mode: "closed" });
    expect(result[0].caption).toBe("No closed work orders in the last 90 days");
    expect(result[1].caption).toBe("No closed work orders in view");
    expect(result[2].caption).toBe("No technician completions this week");
    expect(result[3].caption).toBe("No technician completions this month");
  });

  test("days-to-close buckets cross-check the closed-card denominator", () => {
    const closed = [
      makeWo({ status: "Closed", date_reported: "2026-06-22T09:00:00", date_completed: "2026-06-24T09:00:00" }),
      makeWo({ status: "Closed", date_reported: "2026-06-10T09:00:00", date_completed: "2026-06-23T09:00:00" }),
      makeWo({ status: "Closed", date_reported: null, date_completed: "2026-06-23T09:00:00" }), // undated → neither
    ];
    const { metrics } = buildDaysToCloseDistribution(closed);
    const card = cards({ mode: "closed", closedFiltered: closed })[1];
    expect(metrics.totalClosed).toBe(2);
    expect(card.caption).toBe("Across 2 closed work orders");
  });

  test("make-ready mode aggregates turn groups", () => {
    const unitIndex: UnitIndex = new Map([
      ["M1", makeFacts("M1", { availability: "Ready" })],
      ["M2", makeFacts("M2", { availability: "Down", moveInAt: localMs("2026-07-10T00:00:00") })],
    ]);
    const stageTitles = ["Trash Out", "Punch", "Flooring", "Final Inspection", "Cleaning", "Rekey"];
    const turnWos = stageTitles.map((title, i) =>
      makeWo({
        unit_number: "M1",
        title,
        status: "Completed",
        is_make_ready: true,
        date_reported: i === 0 ? "2026-06-20T09:00:00" : "2026-06-25T09:00:00",
        date_completed: i === 0 ? "2026-07-05T10:00:00" : "2026-07-01T10:00:00",
      }),
    );
    const openTurn = makeWo({
      unit_number: "M2",
      title: "Punch",
      status: "Open",
      is_make_ready: true,
      date_reported: "2026-07-10T09:00:00",
      date_completed: null,
    });
    const groups = buildMakeReadyGroups({ workOrders: [...turnWos, openTurn], unitIndex, nowMs: NOW });
    const result = cards({ mode: "makeReady", makeReadyGroups: groups });

    expect(result.map((c) => c.title)).toEqual([
      "Turns in progress",
      "Completed this month",
      "Avg days in turn",
      "Overdue turns",
    ]);
    expect(result.every((c) => !c.interactive)).toBe(true);
    expect(result[0].value).toBe("1"); // M2 not "Ready"
    expect(result[1].value).toBe("1"); // M1 finished Jul 5
    expect(result[1].caption).toBe("1 turn started this month"); // M2 started Jul 10
    expect(result[2].value).toBe("15.0"); // Jun 20 → Jul 5
    expect(result[2].caption).toBe("Across 1 turns in 90 days");
    expect(result[3].value).toBe("1"); // M2 move-in Jul 10 < today
    expect(result[3].caption).toBe("1 turn past move-in date");
  });

  test("make-ready mode zero branches", () => {
    const result = cards({ mode: "makeReady" });
    expect(result[1].caption).toBe("0 turns started this month");
    expect(result[2].caption).toBe("No completed turns in the last 3 months");
    expect(result[3].caption).toBe("No turns past move-in date");
  });

  test("hot-spots mode sums row signals", () => {
    const rows = [
      makeHotSpotRow({ unitNumber: "101", riskLevel: "High", openCount: 2, callbackCount: 1, recentCount: 3 }),
      makeHotSpotRow({ unitNumber: "202", riskLevel: "Watch", openCount: 0, callbackCount: 0, recentCount: 2 }),
    ];
    const result = cards({ mode: "hotSpots", hotSpotRows: rows });

    expect(result.map((c) => c.title)).toEqual([
      "Hot spot units",
      "High risk units",
      "Open on hot spots",
      "Callback signals",
    ]);
    expect(result.every((c) => !c.interactive)).toBe(true);
    expect(result[0].value).toBe("2");
    expect(result[1].value).toBe("1");
    expect(result[1].caption).toBe("1 unit needs review");
    expect(result[2].value).toBe("2");
    expect(result[2].caption).toBe("Open tickets tied to hot spot units");
    expect(result[3].value).toBe("1");
    expect(result[3].caption).toBe("5 recent tickets in 90 days");
  });

  test("hot-spots mode zero captions", () => {
    const result = cards({ mode: "hotSpots" });
    expect(result[1].caption).toBe("No high-risk hot spots");
    expect(result[2].caption).toBe("No open work on hot spots");
    expect(result[3].caption).toBe("0 recent tickets in 90 days");
  });
});

describe("buildClosedInsights", () => {
  test("weeks bucket reported vs closed on local Monday boundaries", () => {
    const insideReported = makeWo({ status: "Open", date_reported: "2026-06-16" });
    const closedInWindow = makeWo({ date_reported: "2026-06-16", date_completed: "2026-07-14" });
    const outside = makeWo({ status: "Open", date_reported: "2026-04-01" });
    const all = [insideReported, closedInWindow, outside];
    const { weeks } = buildClosedInsights({ allNonMakeReady: all, closedFiltered: [closedInWindow], nowMs: NOW });

    expect(weeks).toHaveLength(6);
    expect(weeks[0].startMs).toBe(localMs("2026-06-08T00:00:00"));
    expect(weeks[5].startMs).toBe(localMs("2026-07-13T00:00:00"));
    // Jun 16 falls in the Jun 15 week (index 1) — both fixtures reported there.
    expect(weeks[1].reported).toBe(2);
    // Jul 14 completion lands in the current (Jul 13) week.
    expect(weeks[5].closed).toBe(1);
    // The April report is outside the 6-week window entirely — only the two
    // Jun 16 reports count.
    expect(weeks.reduce((n, w) => n + w.reported, 0)).toBe(2);
  });

  test("callback rate counts closures a signal ticket points back at, per month", () => {
    const juneClosed = makeWo({ date_completed: "2026-06-10" });
    const juneClean = makeWo({ date_completed: "2026-06-20" });
    const julyClosed = makeWo({ date_completed: "2026-07-02" });
    const signal = makeWo({
      status: "Open",
      date_reported: "2026-06-25",
      callback_status: "confirmed",
      callback_matched_work_order_id: juneClosed.id,
    });
    const closed = [juneClosed, juneClean, julyClosed];
    const { callbackMonths } = buildClosedInsights({
      allNonMakeReady: [...closed, signal],
      closedFiltered: closed,
      nowMs: NOW,
    });

    expect(callbackMonths).toHaveLength(3);
    const [may, june, july] = callbackMonths;
    expect(may.closed).toBe(0);
    expect(may.rate).toBe(0);
    expect(june.closed).toBe(2);
    expect(june.callbacks).toBe(1);
    expect(june.rate).toBeCloseTo(0.5);
    expect(july.closed).toBe(1);
    expect(july.callbacks).toBe(0);
  });

  test("category mix ranks 90-day closures and folds blanks into Other", () => {
    const rows = [
      makeWo({ date_completed: "2026-07-01", category: "Plumbing" }),
      makeWo({ date_completed: "2026-07-02", category: "Plumbing" }),
      makeWo({ date_completed: "2026-07-03", category: "HVAC" }),
      makeWo({ date_completed: "2026-07-04" }),
      // Outside the 90-day window: ignored entirely.
      makeWo({ date_completed: "2025-12-01", category: "Plumbing" }),
    ];
    const { categoryMix, recentClosedCount } = buildClosedInsights({
      allNonMakeReady: rows,
      closedFiltered: rows,
      nowMs: NOW,
    });

    expect(recentClosedCount).toBe(4);
    expect(categoryMix[0]).toMatchObject({ category: "Plumbing", count: 2 });
    expect(categoryMix[0].fraction).toBeCloseTo(0.5);
    expect(categoryMix[1]).toMatchObject({ category: "HVAC", count: 1 });
    // The uncategorized closure folds into the trailing Other slice.
    expect(categoryMix[categoryMix.length - 1]).toMatchObject({ category: null, count: 1 });
  });
});
