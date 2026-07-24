import { describe, expect, test } from "bun:test";

import { WorkOrderSchema, type WorkOrder } from "@/lib/api/work-orders";
import { buildMyWeek, CALLBACK_WINDOW_DAYS } from "@/lib/derived/my-week";
import { parseWorkOrder } from "@/lib/derived/parse";
import type { ParsedWorkOrder } from "@/lib/derived/types";

/**
 * Fixed clock: Wednesday 2026-07-15 noon LOCAL. Monday of this week is Jul 13,
 * last week is Jul 6–12 — so every boundary below is knowable by hand.
 */
const NOW = new Date("2026-07-15T12:00:00").getTime();

let seq = 0;
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

/** Closed by `tech` on `completed`, reported `daysOpen` earlier. */
function closed(tech: string, completed: string, daysOpen = 1, raw: Partial<WorkOrder> = {}) {
  const completedAt = new Date(completed);
  const reported = new Date(completedAt.getTime() - daysOpen * 86_400_000);
  return makeWo({
    technician: tech,
    status: "Completed",
    date_reported: reported.toISOString().slice(0, 19),
    date_completed: completed,
    ...raw,
  });
}

const build = (workOrders: ParsedWorkOrder[], over: Partial<Parameters<typeof buildMyWeek>[0]> = {}) =>
  buildMyWeek({ workOrders, staffName: "Alice", nowMs: NOW, onRouteToday: 0, urgentToday: 0, ...over });

describe("buildMyWeek", () => {
  test("counts only this technician's closes, inside the Monday week", () => {
    const week = build([
      closed("Alice", "2026-07-13T09:00:00"), // Monday, in
      closed("Alice", "2026-07-15T09:00:00"), // Wednesday, in
      closed("Bob", "2026-07-15T09:00:00"), //   someone else
      closed("Alice", "2026-07-12T09:00:00"), // last week
      closed("Alice", "2026-07-20T09:00:00"), // next week
    ]);
    expect(week.thisWeek.closed).toBe(2);
    expect(week.lastWeek.closed).toBe(1);
    expect(week.closedDelta).toBe(1);
  });

  test("per-day columns are Monday-first and mark today", () => {
    const week = build([
      closed("Alice", "2026-07-13T09:00:00"),
      closed("Alice", "2026-07-13T17:00:00"),
      closed("Alice", "2026-07-17T09:00:00"), // Friday
    ]);
    expect(week.perDay.map((d) => d.label)).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
    expect(week.perDay.map((d) => d.count)).toEqual([2, 0, 0, 0, 1, 0, 0]);
    // Wednesday is index 2 on a Monday-anchored week.
    expect(week.perDay.findIndex((d) => d.isToday)).toBe(2);
  });

  test("median days-to-close takes the middle, and averages an even pair", () => {
    const odd = build([
      closed("Alice", "2026-07-13T09:00:00", 1),
      closed("Alice", "2026-07-14T09:00:00", 9),
      closed("Alice", "2026-07-15T09:00:00", 5),
    ]);
    expect(odd.thisWeek.medianDaysToClose).toBe(5);

    const even = build([
      closed("Alice", "2026-07-13T09:00:00", 2),
      closed("Alice", "2026-07-14T09:00:00", 4),
    ]);
    expect(even.thisWeek.medianDaysToClose).toBe(3);
  });

  test("median is null rather than zero when nothing closed", () => {
    // Zero would read as "closes same day", which is a lie about an empty week.
    const week = build([]);
    expect(week.thisWeek.medianDaysToClose).toBeNull();
    expect(week.thisWeek.closed).toBe(0);
  });

  test("make-ready turns are excluded — they run on a different clock", () => {
    const week = build([
      closed("Alice", "2026-07-15T09:00:00"),
      closed("Alice", "2026-07-15T10:00:00", 30, { is_make_ready: true }),
    ]);
    expect(week.thisWeek.closed).toBe(1);
    expect(week.thisWeek.medianDaysToClose).toBe(1);
  });

  test("week labels name this week and last week", () => {
    const week = build([]);
    expect(week.weekLabel).toBe("Jul 13 – Jul 19");
    expect(week.lastWeekLabel).toBe("Jul 6 – Jul 12");
  });

  test("an unknown technician gets a truthful empty week, not someone else's", () => {
    const week = build([closed("Alice", "2026-07-15T09:00:00")], { staffName: "Nobody" });
    expect(week.thisWeek.closed).toBe(0);
    expect(week.perDay.every((d) => d.count === 0)).toBe(true);
  });

  test("callbacks are attributed to whoever closed the original", () => {
    // Bob raises the callback, but Alice closed the original — the rate is hers.
    const original = makeWo({
      resman_work_order_id: "orig-1",
      technician: "Alice",
      status: "Completed",
      date_reported: "2026-07-01T09:00:00",
      date_completed: "2026-07-02T09:00:00",
    });
    const callback = makeWo({
      technician: "Bob",
      status: "Open",
      callback_status: "confirmed",
      callback_matched_work_order_id: "orig-1",
      date_reported: "2026-07-10T09:00:00",
    });
    const week = buildMyWeek({
      workOrders: [original, callback],
      staffName: "Alice",
      nowMs: NOW,
      onRouteToday: 0,
      urgentToday: 0,
    });
    expect(week.callbackCount).toBe(1);
    expect(week.callbackRate).toBeGreaterThan(0);
  });

  test("streak runs from the callback's reported date, capped at the window", () => {
    const original = makeWo({
      resman_work_order_id: "orig-2",
      technician: "Alice",
      status: "Completed",
      date_reported: "2026-07-01T09:00:00",
      date_completed: "2026-07-02T09:00:00",
    });
    const callback = makeWo({
      technician: "Alice",
      status: "Open",
      callback_status: "confirmed",
      callback_matched_work_order_id: "orig-2",
      date_reported: "2026-07-10T09:00:00", // 5 days before Jul 15
    });
    const week = buildMyWeek({
      workOrders: [original, callback],
      staffName: "Alice",
      nowMs: NOW,
      onRouteToday: 0,
      urgentToday: 0,
    });
    expect(week.callbackFreeStreakDays).toBe(5);
    expect(week.streakAtWindowCap).toBe(false);
  });

  test("a clean record reports the window cap, not a fabricated lifetime", () => {
    const week = build([closed("Alice", "2026-07-15T09:00:00")]);
    expect(week.callbackFreeStreakDays).toBe(CALLBACK_WINDOW_DAYS);
    expect(week.streakAtWindowCap).toBe(true);
    expect(week.callbackCount).toBe(0);
  });

  test("a thin record is flagged as a small sample", () => {
    // Two completions cannot support a percentage; the card must say so.
    const week = build([
      closed("Alice", "2026-07-13T09:00:00"),
      closed("Alice", "2026-07-14T09:00:00"),
    ]);
    expect(week.callbackSmallSample).toBe(true);
  });

  test("today's route figures pass through", () => {
    const week = build([], { onRouteToday: 6, urgentToday: 2 });
    expect(week.onRouteToday).toBe(6);
    expect(week.urgentToday).toBe(2);
  });
});
