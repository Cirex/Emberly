import { describe, expect, test } from "bun:test";

import {
  elapsedMs,
  emptyEntry,
  formatDuration,
  formatShortDuration,
  isRunning,
  jobSummaryLine,
  partsCount,
  type JobTimeEntry,
} from "@/lib/derived/job-time";

const NOW = new Date("2026-07-24T12:00:00").getTime();
const MIN = 60_000;

const entry = (over: Partial<JobTimeEntry> = {}): JobTimeEntry => ({
  ...emptyEntry("wo-1"),
  ...over,
});

describe("elapsedMs", () => {
  test("a paused entry reports only what it banked", () => {
    expect(elapsedMs(entry({ accumulatedMs: 42 * MIN }), NOW)).toBe(42 * MIN);
  });

  test("a running entry adds the run in flight", () => {
    const e = entry({ accumulatedMs: 40 * MIN, runningSince: NOW - 2 * MIN });
    expect(elapsedMs(e, NOW)).toBe(42 * MIN);
  });

  test("a backwards clock stalls the timer rather than running it backwards", () => {
    // NTP correction / timezone change / a tech setting the clock. Subtracting
    // time from a job is worse than briefly stalling.
    const e = entry({ accumulatedMs: 40 * MIN, runningSince: NOW + 5 * MIN });
    expect(elapsedMs(e, NOW)).toBe(40 * MIN);
  });

  test("a corrupt negative bank never reports negative time", () => {
    expect(elapsedMs(entry({ accumulatedMs: -1000 }), NOW)).toBe(0);
  });

  test("a missing entry is zero, not a crash", () => {
    expect(elapsedMs(undefined, NOW)).toBe(0);
  });
});

describe("isRunning", () => {
  test("distinguishes running from paused and missing", () => {
    expect(isRunning(entry({ runningSince: NOW }))).toBe(true);
    expect(isRunning(entry())).toBe(false);
    expect(isRunning(undefined)).toBe(false);
  });
});

describe("formatDuration", () => {
  test("is always H:MM:SS so the display does not reflow as it ticks", () => {
    expect(formatDuration(0)).toBe("00:00:00");
    expect(formatDuration(42 * MIN + 15_000)).toBe("00:42:15");
    expect(formatDuration(3 * 3600_000 + 5 * MIN + 9000)).toBe("03:05:09");
  });

  test("never renders negative time", () => {
    expect(formatDuration(-5000)).toBe("00:00:00");
  });
});

describe("formatShortDuration", () => {
  test("rounds to the minute", () => {
    expect(formatShortDuration(42 * MIN)).toBe("42m");
    expect(formatShortDuration(42 * MIN + 40_000)).toBe("43m");
  });

  test("splits hours", () => {
    expect(formatShortDuration(72 * MIN)).toBe("1h 12m");
    expect(formatShortDuration(120 * MIN)).toBe("2h");
  });

  test("a worked job is never reported as 0m", () => {
    // Rounding a 20-second job to "0m" would read as "never touched it".
    expect(formatShortDuration(20_000)).toBe("<1m");
    expect(formatShortDuration(0)).toBe("0m");
  });
});

describe("partsCount", () => {
  test("sums quantities rather than counting lines", () => {
    const e = entry({
      parts: [
        { id: "a", name: "T&P valve", quantity: 1 },
        { id: "b", name: "Teflon tape", quantity: 3 },
      ],
    });
    expect(partsCount(e)).toBe(4);
  });

  test("is zero for an empty or missing entry", () => {
    expect(partsCount(entry())).toBe(0);
    expect(partsCount(undefined)).toBe(0);
  });
});

describe("jobSummaryLine", () => {
  test("reports time and parts together", () => {
    const e = entry({
      accumulatedMs: 42 * MIN,
      parts: [
        { id: "a", name: "T&P valve", quantity: 1 },
        { id: "b", name: "Anode rod", quantity: 2 },
      ],
    });
    expect(jobSummaryLine(e, NOW)).toBe("Time on job: 42m · Parts: T&P valve ×1, Anode rod ×2");
  });

  test("reports time alone when no parts were used", () => {
    expect(jobSummaryLine(entry({ accumulatedMs: 15 * MIN }), NOW)).toBe("Time on job: 15m");
  });

  test("reports parts alone when the timer was never started", () => {
    const e = entry({ parts: [{ id: "a", name: "Washer", quantity: 2 }] });
    expect(jobSummaryLine(e, NOW)).toBe("Parts: Washer ×2");
  });

  test("is empty when nothing was tracked, so a plain close stays untouched", () => {
    expect(jobSummaryLine(entry(), NOW)).toBe("");
    expect(jobSummaryLine(undefined, NOW)).toBe("");
  });

  test("blank and zero-quantity parts are dropped, not printed", () => {
    const e = entry({
      accumulatedMs: 5 * MIN,
      parts: [
        { id: "a", name: "   ", quantity: 1 },
        { id: "b", name: "Washer", quantity: 0 },
      ],
    });
    expect(jobSummaryLine(e, NOW)).toBe("Time on job: 5m");
  });

  test("includes the run still in flight", () => {
    const e = entry({ accumulatedMs: 40 * MIN, runningSince: NOW - 2 * MIN });
    expect(jobSummaryLine(e, NOW)).toBe("Time on job: 42m");
  });
});
