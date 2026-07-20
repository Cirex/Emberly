const assert = require("node:assert/strict");
const test = require("node:test");

const { MLGWHTTPClient } = require("../src/mlgw/http.ts");
const { RequestScheduler } = require("../src/shared/request-scheduler.ts");

/** Minimal fake Response the MLGW client's singleRequest reads from. */
function fakeResponse() {
  return {
    status: 200,
    url: "https://mymlgw.mlgw.org/x",
    headers: { get: () => null, forEach: () => {} },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  };
}

/** A fetch impl that records peak simultaneous in-flight calls. */
function trackingFetch(track) {
  return async () => {
    track.active += 1;
    track.peak = Math.max(track.peak, track.active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    track.active -= 1;
    return fakeResponse();
  };
}

test("MLGW client copies share one scheduler ceiling (nested pools can't exceed it)", async () => {
  const track = { active: 0, peak: 0 };
  const scheduler = new RequestScheduler(2);
  const root = new MLGWHTTPClient({ fetchImpl: trackingFetch(track), scheduler });

  // Fire 12 requests across independent per-worker copies concurrently — exactly
  // the nested-pool shape the payment/bill parallelization produces.
  const copies = Array.from({ length: 12 }, () => root.copyForConcurrentRequests());
  await Promise.all(copies.map((c) => c.request("GET", "https://mymlgw.mlgw.org/x")));

  assert.equal(track.active, 0);
  assert.ok(track.peak <= 2, `peak in-flight ${track.peak} exceeded the shared cap of 2`);
  assert.ok(track.peak >= 2, `expected the pool to actually reach its cap, saw ${track.peak}`);
});

test("MLGW default client bounds its own requests without an explicit scheduler", async () => {
  const track = { active: 0, peak: 0 };
  // No scheduler passed → constructor creates one at the default ceiling (6).
  const client = new MLGWHTTPClient({ fetchImpl: trackingFetch(track) });
  await Promise.all(
    Array.from({ length: 20 }, () => client.request("GET", "https://mymlgw.mlgw.org/x")),
  );
  assert.equal(track.active, 0);
  assert.ok(track.peak <= 6, `peak in-flight ${track.peak} exceeded the default cap of 6`);
});
