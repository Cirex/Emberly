import { afterEach, describe, expect, test } from "bun:test";
import {
  registerSync,
  registeredSyncs,
  runSyncTick,
  unregisterSync,
} from "@/lib/sync-registry";

const CONFIG = { baseUrl: "http://example.test", token: "eapi_test" };

// The registry is module-global (that's the point — stores self-register on
// import), so each test cleans up the names it added.
const added: string[] = [];
function add(name: string, fn: Parameters<typeof registerSync>[1]) {
  registerSync(name, fn);
  added.push(name);
}

afterEach(() => {
  for (const name of added.splice(0)) unregisterSync(name);
});

describe("sync registry", () => {
  test("runs every registered participant with the config", async () => {
    const seen: { name: string; baseUrl: string }[] = [];
    add("a", async (config) => {
      seen.push({ name: "a", baseUrl: config.baseUrl });
    });
    add("b", async (config) => {
      seen.push({ name: "b", baseUrl: config.baseUrl });
    });

    await runSyncTick(CONFIG);

    expect(seen).toHaveLength(2);
    expect(seen.map((s) => s.name).sort()).toEqual(["a", "b"]);
    expect(seen.every((s) => s.baseUrl === CONFIG.baseUrl)).toBe(true);
  });

  test("one participant rejecting neither throws nor starves the others", async () => {
    let ran = false;
    add("bad", async () => {
      throw new Error("network down");
    });
    add("good", async () => {
      ran = true;
    });

    // Must resolve (allSettled), never reject.
    await expect(runSyncTick(CONFIG)).resolves.toBeUndefined();
    expect(ran).toBe(true);
  });

  test("re-registering a name replaces, not duplicates (hot reload safety)", async () => {
    let calls = 0;
    add("units-test", async () => {
      calls += 1;
    });
    // Same name again — e.g. the module re-evaluated during fast refresh.
    registerSync("units-test", async () => {
      calls += 10;
    });

    await runSyncTick(CONFIG);

    expect(calls).toBe(10);
    expect(registeredSyncs().filter((n) => n === "units-test")).toHaveLength(1);
  });
});
