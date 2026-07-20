
const assert = require("node:assert/strict");
const test = require("node:test");

const { callWithAccessRetry } = require("../lib/entryPassRefresh");

function staleAccessError() {
  const error = new Error("Resident access needs to be refreshed");
  error.reason = "resident_access_stale";
  return error;
}

function makeHarness({ callResults, heartbeatStatus }) {
  const calls = { call: 0, verify: 0, logout: 0 };
  return {
    calls,
    options: (overrides = {}) => ({
      call: async () => {
        const result = callResults[calls.call];
        calls.call += 1;
        if (result instanceof Error) throw result;
        return result;
      },
      verifyAccess: async () => {
        calls.verify += 1;
        return { status: heartbeatStatus };
      },
      logout: async () => {
        calls.logout += 1;
      },
      logoutMessage: "Session expired. Please sign in again.",
      ...overrides,
    }),
  };
}

test("callWithAccessRetry passes through a successful call without a heartbeat", async () => {
  const harness = makeHarness({ callResults: ["token-1"], heartbeatStatus: "valid" });

  assert.equal(await callWithAccessRetry(harness.options()), "token-1");
  assert.deepEqual(harness.calls, { call: 1, verify: 0, logout: 0 });
});

test("callWithAccessRetry rethrows non-stale errors without a heartbeat", async () => {
  const failure = new Error("Server exploded");
  const harness = makeHarness({ callResults: [failure], heartbeatStatus: "valid" });

  await assert.rejects(callWithAccessRetry(harness.options()), failure);
  assert.deepEqual(harness.calls, { call: 1, verify: 0, logout: 0 });
});

test("callWithAccessRetry retries once after a valid heartbeat", async () => {
  const harness = makeHarness({
    callResults: [staleAccessError(), "token-2"],
    heartbeatStatus: "valid",
  });

  assert.equal(await callWithAccessRetry(harness.options()), "token-2");
  assert.deepEqual(harness.calls, { call: 2, verify: 1, logout: 0 });
});

test("callWithAccessRetry logs out when the heartbeat reports an invalid session", async () => {
  const harness = makeHarness({
    callResults: [staleAccessError()],
    heartbeatStatus: "invalid",
  });

  await assert.rejects(callWithAccessRetry(harness.options()), {
    message: "Session expired. Please sign in again.",
  });
  assert.deepEqual(harness.calls, { call: 1, verify: 1, logout: 1 });
});

test("callWithAccessRetry does not log out when the heartbeat is unknown (offline)", async () => {
  const staleError = staleAccessError();
  const harness = makeHarness({
    callResults: [staleError],
    heartbeatStatus: "unknown",
  });

  // Offline / 5xx heartbeats must never force a logout: rethrow the original
  // error and keep the session.
  await assert.rejects(callWithAccessRetry(harness.options()), staleError);
  assert.deepEqual(harness.calls, { call: 1, verify: 1, logout: 0 });
});

test("callWithAccessRetry rethrows stale-access errors when no heartbeat is available", async () => {
  const staleError = staleAccessError();
  const harness = makeHarness({ callResults: [staleError], heartbeatStatus: "valid" });

  await assert.rejects(
    callWithAccessRetry(harness.options({ verifyAccess: null })),
    staleError
  );
  assert.deepEqual(harness.calls, { call: 1, verify: 0, logout: 0 });
});
