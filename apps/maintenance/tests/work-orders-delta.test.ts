import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Delta sync for the work-order board.
 *
 * The tick used to re-download every work order every 60 seconds and compare
 * JSON. Now it asks only for rows changed since the last read, which is what
 * lets the interval drop to 15s and lets a silent push trigger a sync
 * immediately. Three things have to hold, and each fails silently if it doesn't:
 *
 *   - the cursor must come from the SERVER's updated_at, never the device clock;
 *   - a delta must MERGE onto the cache, not replace it;
 *   - deletions must still be caught — a delta read only ever returns rows that
 *     still exist, so a work order removed from ResMan would otherwise stay on
 *     the board forever.
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

/**
 * Only the fields these tests exercise. The api module is mocked, so its zod
 * schema never runs — but the store's own type is the full WorkOrder, hence the
 * cast at each setState below.
 */
interface Row {
  resman_work_order_id: string;
  title: string;
  updated_at: string;
  status: string;
}

/** Partial rows into the store's WorkOrder[] slot. See Row above. */
function asWorkOrders(list: Row[]): never {
  return list as never;
}

/** The server's table, and a log of what each request asked for. */
let table: Row[] = [];
let requests: Array<{ updatedSince?: string; limit: number }> = [];
/** When set, every request throws with this message (offline simulation). */
let failWith: string | null = null;

function row(id: string, over: Partial<Row> = {}): Row {
  return {
    resman_work_order_id: id,
    title: `wo ${id}`,
    updated_at: "2026-07-24T12:00:00.000Z",
    status: "Not Started",
    ...over,
  };
}

mock.module("@/lib/api/work-orders", () => ({
  listWorkOrders: async (params: { limit?: number; offset?: number; updatedSince?: string }) => {
    const limit = params.limit ?? 200;
    requests.push({ updatedSince: params.updatedSince, limit });
    if (failWith) throw new Error(failWith);
    const matching = params.updatedSince
      ? table.filter((r) => r.updated_at > params.updatedSince!)
      : table;
    const offset = params.offset ?? 0;
    const page = matching.slice(offset, offset + limit);
    return {
      // The store's zod schema is bypassed here (the module is mocked), so rows
      // only need the fields under test.
      data: page,
      pagination: {
        limit,
        offset,
        // `count` is the total matching the FILTER — for an unfiltered request
        // that is the table size, which is how deletions are detected.
        count: matching.length,
        hasMore: offset + page.length < matching.length,
      },
    };
  },
}));

const config = { baseUrl: "https://example.test", token: "t" } as never;

/**
 * Full-table reads issued this tick — the one-row count probe excluded.
 *
 * Worth asserting on directly, because a broken merge is SELF-HEALING: losing
 * the cache makes the row count disagree, which triggers the reconcile, which
 * produces the right data. The board looks fine and every 15s tick quietly
 * downloads the whole board — precisely the cost this feature removes. Only the
 * request log shows it.
 */
function fullReads(): number {
  return requests.filter((r) => r.updatedSince === undefined && r.limit > 1).length;
}

beforeEach(() => {
  store.clear();
  requests = [];
  table = [];
  failWith = null;
});

describe("work orders — delta sync", () => {
  test("the first refresh reads everything and takes its cursor from the server", async () => {
    const { useWorkOrders } = await import("@/lib/stores/work-orders");
    useWorkOrders.setState({ workOrders: [], deltaCursor: "", dataVersion: 0, refreshedAt: 0 });
    table = [
      row("a", { updated_at: "2026-07-24T10:00:00.000Z" }),
      row("b", { updated_at: "2026-07-24T11:30:00.000Z" }),
    ];

    await useWorkOrders.getState().refresh(config);

    expect(useWorkOrders.getState().workOrders).toHaveLength(2);
    // The newest server timestamp — NOT Date.now(). A device clock even
    // slightly ahead would ask for changes since a moment the server hasn't
    // reached and skip those rows permanently.
    expect(useWorkOrders.getState().deltaCursor).toBe("2026-07-24T11:30:00.000Z");
    expect(requests.every((r) => r.updatedSince === undefined)).toBe(true);
  });

  test("a quiet tick fetches only the delta and does not bump dataVersion", async () => {
    const { useWorkOrders } = await import("@/lib/stores/work-orders");
    table = [row("a"), row("b")];
    useWorkOrders.setState({
      workOrders: asWorkOrders(table.slice()),
      deltaCursor: "2026-07-24T12:00:00.000Z",
      dataVersion: 5,
    });

    await useWorkOrders.getState().refresh(config);

    expect(requests.some((r) => r.updatedSince === "2026-07-24T12:00:00.000Z")).toBe(true);
    // Nothing moved: the derived snapshots must not be rebuilt just to confirm
    // that. This is the whole point of the delta read.
    expect(useWorkOrders.getState().dataVersion).toBe(5);
    expect(useWorkOrders.getState().refreshedAt).toBeGreaterThan(0);
    expect(fullReads()).toBe(0);
  });

  test("a changed row is merged onto the cache, not swapped in as the whole list", async () => {
    const { useWorkOrders } = await import("@/lib/stores/work-orders");
    useWorkOrders.setState({
      workOrders: asWorkOrders([row("a"), row("b"), row("c")]),
      deltaCursor: "2026-07-24T12:00:00.000Z",
      dataVersion: 1,
    });
    // Only 'b' moved. A replace-instead-of-merge bug would leave the board
    // showing exactly one work order.
    table = [
      row("a"),
      row("b", { title: "reassigned", status: "In Progress", updated_at: "2026-07-24T13:00:00.000Z" }),
      row("c"),
    ];

    await useWorkOrders.getState().refresh(config);

    const rows = useWorkOrders.getState().workOrders;
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.resman_work_order_id === "b")?.status).toBe("In Progress");
    expect(rows.find((r) => r.resman_work_order_id === "a")?.title).toBe("wo a");
    expect(useWorkOrders.getState().dataVersion).toBe(2);
    expect(useWorkOrders.getState().deltaCursor).toBe("2026-07-24T13:00:00.000Z");
    // The delta alone had to be enough. No full page may be fetched.
    expect(fullReads()).toBe(0);
  });

  test("a new work order arrives through the delta", async () => {
    const { useWorkOrders } = await import("@/lib/stores/work-orders");
    useWorkOrders.setState({
      workOrders: asWorkOrders([row("a")]),
      deltaCursor: "2026-07-24T12:00:00.000Z",
      dataVersion: 1,
    });
    table = [row("a"), row("new", { updated_at: "2026-07-24T14:00:00.000Z" })];

    await useWorkOrders.getState().refresh(config);

    expect(useWorkOrders.getState().workOrders.map((r) => r.resman_work_order_id).sort()).toEqual([
      "a",
      "new",
    ]);
    expect(fullReads()).toBe(0);
  });

  test("a DELETED work order is caught by the count check and reconciled away", async () => {
    const { useWorkOrders } = await import("@/lib/stores/work-orders");
    useWorkOrders.setState({
      workOrders: asWorkOrders([row("a"), row("gone")]),
      deltaCursor: "2026-07-24T12:00:00.000Z",
      dataVersion: 1,
    });
    // 'gone' was removed from ResMan and swept by delete-missing. A delta read
    // can never report it — only the row count reveals the drift.
    table = [row("a")];

    await useWorkOrders.getState().refresh(config);

    expect(useWorkOrders.getState().workOrders.map((r) => r.resman_work_order_id)).toEqual(["a"]);
    // The recovery is a full read — and here it is the CORRECT response, unlike
    // in the tests above where a full read would mean the delta path failed.
    expect(fullReads()).toBeGreaterThan(0);
  });

  test("a failed refresh leaves the cache and the cursor untouched", async () => {
    const { useWorkOrders } = await import("@/lib/stores/work-orders");
    const cached = [row("a")];
    useWorkOrders.setState({
      workOrders: asWorkOrders(cached),
      deltaCursor: "2026-07-24T12:00:00.000Z",
      dataVersion: 3,
    });

    failWith = "offline";
    await useWorkOrders.getState().refresh(config);

    expect(useWorkOrders.getState().workOrders).toEqual(asWorkOrders(cached));
    // Advancing the cursor on a failure would skip every change in that window.
    expect(useWorkOrders.getState().deltaCursor).toBe("2026-07-24T12:00:00.000Z");
    expect(useWorkOrders.getState().dataVersion).toBe(3);
  });
});
