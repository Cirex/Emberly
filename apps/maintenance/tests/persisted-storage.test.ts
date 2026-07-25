import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * The persist write gate.
 *
 * zustand writes the whole persisted payload on every `set()`, so the work-order
 * store re-serialized 3.79 MB of mirror to AsyncStorage every 15 seconds just to
 * record that a quiet sync had happened. The gate skips writes whose content is
 * unchanged.
 *
 * The failure mode on the other side is far worse than a slow write: a gate that
 * skips a write it should have made loses a technician's queued work silently.
 * So these assert the SKIPS and the WRITES with equal weight.
 */

const disk = new Map<string, string>();
let writes = 0;
let reads = 0;

mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => {
      reads += 1;
      return disk.get(k) ?? null;
    },
    setItem: async (k: string, v: string) => {
      writes += 1;
      disk.set(k, v);
    },
    removeItem: async (k: string) => void disk.delete(k),
  },
}));

const { persistedStorage } = await import("@/lib/stores/persisted-storage");

interface State {
  rows: unknown[];
  version: number;
}

const NAME = "test-store";

describe("persisted storage gate", () => {
  beforeEach(() => {
    disk.clear();
    writes = 0;
    reads = 0;
  });

  test("the first write lands", async () => {
    const storage = persistedStorage<State>();
    const rows = [{ id: "a" }];
    await storage.setItem(NAME, { state: { rows, version: 1 }, version: 0 });
    expect(writes).toBe(1);
    expect(disk.get(NAME)).toContain('"id":"a"');
  });

  test("a repeat of the same content writes nothing", async () => {
    const storage = persistedStorage<State>();
    const rows = [{ id: "a" }];
    await storage.setItem(NAME, { state: { rows, version: 1 }, version: 0 });
    // What a quiet sync tick produces: a fresh partialize object holding the
    // very same slices. Four of these a minute is what the gate exists for.
    await storage.setItem(NAME, { state: { rows, version: 1 }, version: 0 });
    await storage.setItem(NAME, { state: { rows, version: 1 }, version: 0 });
    expect(writes).toBe(1);
  });

  test("a changed slice always writes — this is the data-loss direction", async () => {
    const storage = persistedStorage<State>();
    const rows = [{ id: "a" }];
    await storage.setItem(NAME, { state: { rows, version: 1 }, version: 0 });
    // New array identity: the store replaced its data.
    const grown = [{ id: "a" }, { id: "b" }];
    await storage.setItem(NAME, { state: { rows: grown, version: 2 }, version: 0 });
    expect(writes).toBe(2);
    expect(disk.get(NAME)).toContain('"id":"b"');

    // A scalar moving on its own must write too.
    await storage.setItem(NAME, { state: { rows: grown, version: 3 }, version: 0 });
    expect(writes).toBe(3);
  });

  test("equal-but-rebuilt data still writes — the gate errs toward the disk", async () => {
    // The compare is by REFERENCE, not by value: a store that rebuilt its array
    // with identical contents pays a write. That is the safe direction to be
    // wrong in, and stores update immutably, so it is also the rare one.
    const storage = persistedStorage<State>();
    await storage.setItem(NAME, { state: { rows: [{ id: "a" }], version: 1 }, version: 0 });
    await storage.setItem(NAME, { state: { rows: [{ id: "a" }], version: 1 }, version: 0 });
    expect(writes).toBe(2);
  });

  test("adding or removing a key counts as a change", async () => {
    const storage = persistedStorage<State>();
    const rows: unknown[] = [];
    await storage.setItem(NAME, { state: { rows, version: 1 }, version: 0 });
    await storage.setItem(NAME, { state: { rows } as State, version: 0 });
    expect(writes).toBe(2);
  });

  test("hydration seeds the gate, so the echo write after it is skipped", async () => {
    disk.set(NAME, JSON.stringify({ state: { rows: [{ id: "a" }], version: 3 }, version: 0 }));
    const storage = persistedStorage<State>();
    const hydrated = await storage.getItem(NAME);
    expect(hydrated?.state.version).toBe(3);
    // zustand writes once right after hydrating; the values are the ones it just
    // read, so nothing should reach the disk.
    await storage.setItem(NAME, { state: hydrated!.state, version: 0 });
    expect(writes).toBe(0);
  });

  test("a purge clears the gate, so the store re-persists afterwards", async () => {
    const storage = persistedStorage<State>();
    const empty: unknown[] = [];
    await storage.setItem(NAME, { state: { rows: empty, version: 1 }, version: 0 });
    expect(writes).toBe(1);

    // Sign-out: reset to initial state, then clearStorage().
    await storage.removeItem(NAME);
    expect(disk.has(NAME)).toBe(false);

    // The same state object again. Without clearing the gate this would be
    // skipped and the store would sit unpersisted until something else changed.
    await storage.setItem(NAME, { state: { rows: empty, version: 1 }, version: 0 });
    expect(writes).toBe(2);
    expect(disk.has(NAME)).toBe(true);
  });

  test("each store gets its own gate", async () => {
    const a = persistedStorage<State>();
    const b = persistedStorage<State>();
    const rows: unknown[] = [];
    await a.setItem("a", { state: { rows, version: 1 }, version: 0 });
    await b.setItem("b", { state: { rows, version: 1 }, version: 0 });
    expect(writes).toBe(2);
  });
});
