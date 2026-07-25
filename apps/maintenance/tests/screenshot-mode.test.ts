import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Screenshot mode exists so App Store images cannot contain real resident data.
 * App Store screenshots are PUBLIC: a shot of the live board publishes unit
 * numbers, technician names and text describing what is wrong inside a named
 * resident's home.
 *
 * Two properties have to hold, and the second is the one that is easy to get
 * wrong — I got it wrong once while writing this:
 *
 *   1. OFF by default. A normal build must never render fixtures.
 *   2. Seeding is not sufficient. The tab layout's sync tick fires within a
 *      second of launch; if it still runs, it replaces the fixtures with the
 *      live board and the screenshot shows real data anyway.
 *
 * And a third, from the bug: seeding must actually HAPPEN. An early `return`
 * that skipped the seed produced an empty board — which is safe, but useless,
 * and only visible by launching the app.
 */

const store = new Map<string, string>();
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
  },
}));
mock.module("@/lib/analytics", () => ({
  capture: () => {},
  identify: () => {},
  resetAnalytics: () => {},
  reportSyncFailed: () => {},
  reportSyncSucceeded: () => {},
}));

let listCalls = 0;
mock.module("@/lib/api/work-orders", () => ({
  listWorkOrders: async () => {
    listCalls += 1;
    // Stand-in for the live board. If this ever reaches a screenshot, the real
    // equivalent would be a resident's data on the App Store.
    return {
      data: [
        {
          resman_work_order_id: "REAL-1",
          unit_number: "0101",
          title: "REAL RESIDENT DATA",
          updated_at: "2026-07-25T00:00:00.000Z",
          status: "Not Started",
        },
      ],
      pagination: { limit: 200, offset: 0, count: 1, hasMore: false },
    };
  },
}));

const config = { baseUrl: "https://example.test", token: "t" } as never;

beforeEach(() => {
  store.clear();
  listCalls = 0;
});

describe("screenshot mode", () => {
  test("is OFF unless the build sets the flag", async () => {
    delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
    const { isScreenshotMode } = await import("@/lib/screenshot-mode");
    expect(isScreenshotMode()).toBe(false);
    // Only the exact value counts — no truthy-string surprises.
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = "0";
    expect(isScreenshotMode()).toBe(false);
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = "true";
    expect(isScreenshotMode()).toBe(false);
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = "1";
    expect(isScreenshotMode()).toBe(true);
    delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
  });

  test("the fixtures are worth screenshotting", async () => {
    const { SCREENSHOT_WORK_ORDERS, SCREENSHOT_MIN_WORK_ORDERS } = await import(
      "@/lib/screenshot-mode"
    );
    // An empty or one-row board sells nothing, and a uniform one looks fake.
    expect(SCREENSHOT_WORK_ORDERS.length).toBeGreaterThanOrEqual(SCREENSHOT_MIN_WORK_ORDERS);
    expect(new Set(SCREENSHOT_WORK_ORDERS.map((w) => w.priority)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(SCREENSHOT_WORK_ORDERS.map((w) => w.status)).size).toBeGreaterThanOrEqual(3);
    // Every row needs the fields the board renders, or a card comes out blank.
    for (const wo of SCREENSHOT_WORK_ORDERS) {
      expect(wo.unit_number.length).toBeGreaterThan(0);
      expect(wo.title.length).toBeGreaterThan(0);
    }
  });

  test("loadAll seeds fixtures and never calls the API", async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = "1";
    const { useWorkOrders } = await import("@/lib/stores/work-orders");
    const { SCREENSHOT_WORK_ORDERS } = await import("@/lib/screenshot-mode");

    await useWorkOrders.getState().loadAll(config);

    expect(useWorkOrders.getState().workOrders).toHaveLength(SCREENSHOT_WORK_ORDERS.length);
    // The point: no request was made, so no real record could arrive.
    expect(listCalls).toBe(0);
    delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
  });

  test("refresh CANNOT replace fixtures with the live board", async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = "1";
    const { useWorkOrders } = await import("@/lib/stores/work-orders");
    await useWorkOrders.getState().loadAll(config);
    const seeded = useWorkOrders.getState().workOrders.length;

    // Even called directly — the path the sync tick would take.
    await useWorkOrders.getState().refresh(config);

    expect(listCalls).toBe(0);
    expect(useWorkOrders.getState().workOrders).toHaveLength(seeded);
    expect(
      useWorkOrders.getState().workOrders.some((w) => w.title === "REAL RESIDENT DATA"),
    ).toBe(false);
    delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
  });

  test("the tab layout seeds BEFORE returning, so the board is not empty", () => {
    // A source scan, because the effect needs a mounted navigator to run. The
    // ordering is the bug that already happened: an early return placed above
    // the seed left the board blank, visible only by launching the app.
    const src = readFileSync(
      path.join(import.meta.dir, "..", "app", "(tabs)", "_layout.tsx"),
      "utf8",
    );
    const guard = src.indexOf("if (isScreenshotMode())");
    const seed = src.indexOf("loadAll(config)", guard);
    const ret = src.indexOf("return;", guard);
    expect(guard).toBeGreaterThan(-1);
    expect(seed).toBeGreaterThan(guard);
    expect(seed).toBeLessThan(ret);
  });
});
