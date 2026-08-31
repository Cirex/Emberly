import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Delta sync for the unit roster.
 *
 * refresh() used to re-download all ~900 units — the app's largest recurring
 * transfer — on every 15s tick, against a mirror the sync cron only rewrites
 * hourly. It now asks for what MOVED. The same three invariants the work-order
 * delta depends on have to hold here, and each fails silently if it doesn't:
 *
 *   - the cursor comes from the SERVER's updated_at, never the device clock;
 *   - a delta MERGES onto the cache rather than replacing it;
 *   - deletions are still caught — a delta only ever returns rows that still
 *     exist, so a unit removed from ResMan would otherwise sit on the map
 *     forever. The row count is what catches it.
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

interface Row {
  resman_unit_id: string;
  number: string;
  updated_at: string;
}

/** Every listUnits call the store made, in order. */
let calls: Array<{ updatedSince?: string; limit?: number; offset?: number }> = [];
/** What the fake server holds, newest-wins by id. */
let serverRows: Row[] = [];

mock.module("@/lib/api/units", () => ({
  listUnits: async (params: { limit?: number; offset?: number; updatedSince?: string }) => {
    calls.push(params);
    const matching = params.updatedSince
      ? serverRows.filter((r) => r.updated_at > (params.updatedSince as string))
      : serverRows;
    // limit:1 is the count probe — it must report the FULL count, not 1.
    const data = params.limit === 1 ? matching.slice(0, 1) : matching;
    return {
      data,
      pagination: {
        limit: params.limit ?? 200,
        offset: params.offset ?? 0,
        count: matching.length,
        hasMore: false,
      },
    };
  },
}));

const { useUnits } = await import("@/lib/stores/units");

const CONFIG = { baseUrl: "https://x", token: "t" };
const unit = (id: string, number: string, updated: string): Row => ({
  resman_unit_id: id,
  number,
  updated_at: updated,
});

function seedCache(rows: Row[], cursor: string) {
  useUnits.setState({ allUnits: rows as never, deltaCursor: cursor, units: [], total: 0 });
}

beforeEach(() => {
  calls = [];
  serverRows = [];
  useUnits.setState({ allUnits: [], deltaCursor: "", units: [], total: 0, filter: "All" as never });
});

describe("units delta sync", () => {
  test("with no cursor, the first refresh reads everything and adopts the SERVER's newest stamp", async () => {
    serverRows = [
      unit("u1", "101", "2026-08-28T10:00:00Z"),
      unit("u2", "102", "2026-08-28T12:00:00Z"),
    ];
    await useUnits.getState().refresh(CONFIG);
    // No updated_since on the roster read — it is the establishing full read.
    expect(calls.some((c) => c.updatedSince)).toBe(false);
    expect(useUnits.getState().allUnits).toHaveLength(2);
    // The cursor is the newest row's stamp, not Date.now().
    expect(useUnits.getState().deltaCursor).toBe("2026-08-28T12:00:00Z");
  });

  test("with a cursor, only changed units are requested and they MERGE onto the cache", async () => {
    seedCache(
      [unit("u1", "101", "2026-08-28T10:00:00Z"), unit("u2", "102", "2026-08-28T10:00:00Z")],
      "2026-08-28T10:00:00Z",
    );
    // u2 was renumbered; u1 untouched. The server still holds both.
    serverRows = [
      unit("u1", "101", "2026-08-28T10:00:00Z"),
      unit("u2", "102-B", "2026-08-28T11:00:00Z"),
    ];
    await useUnits.getState().refresh(CONFIG);

    const roster = calls.filter((c) => c.updatedSince);
    expect(roster.length).toBeGreaterThan(0);
    expect(roster[0].updatedSince).toBe("2026-08-28T10:00:00Z");

    const all = useUnits.getState().allUnits as unknown as Row[];
    expect(all).toHaveLength(2); // merged, not replaced by the single changed row
    expect(all.find((r) => r.resman_unit_id === "u2")?.number).toBe("102-B");
    expect(all.find((r) => r.resman_unit_id === "u1")?.number).toBe("101");
    expect(useUnits.getState().deltaCursor).toBe("2026-08-28T11:00:00Z");
  });

  test("a quiet tick changes no state and never advances the cursor past the server", async () => {
    const cached = [unit("u1", "101", "2026-08-28T10:00:00Z")];
    seedCache(cached, "2026-08-28T10:00:00Z");
    serverRows = cached;
    const before = useUnits.getState().allUnits;
    await useUnits.getState().refresh(CONFIG);
    // Identity preserved: no new array, so nothing downstream re-renders.
    expect(useUnits.getState().allUnits).toBe(before);
    expect(useUnits.getState().deltaCursor).toBe("2026-08-28T10:00:00Z");
  });

  test("a DELETED unit is caught by the count and repaired by a full read", async () => {
    // Cache holds two; the server now holds only one, and the survivor did not
    // change — so the delta comes back EMPTY and only the count reveals it.
    seedCache(
      [unit("u1", "101", "2026-08-28T10:00:00Z"), unit("u2", "102", "2026-08-28T10:00:00Z")],
      "2026-08-28T10:00:00Z",
    );
    serverRows = [unit("u1", "101", "2026-08-28T10:00:00Z")];

    await useUnits.getState().refresh(CONFIG);

    const all = useUnits.getState().allUnits as unknown as Row[];
    expect(all).toHaveLength(1);
    expect(all[0].resman_unit_id).toBe("u1");
    // The repair path re-read everything rather than trusting the delta.
    expect(calls.some((c) => !c.updatedSince && c.limit !== 1)).toBe(true);
  });
});
