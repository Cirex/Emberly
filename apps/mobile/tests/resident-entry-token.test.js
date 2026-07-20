
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  secondsUntilEntryTokenExpiry,
} = require("../lib/residentEntryToken");
const {
  shouldRetryEntryTokenAfterHeartbeat,
} = require("../lib/entryPassRefresh");

test("resident entry token countdown uses server expiry", () => {
  assert.equal(
    secondsUntilEntryTokenExpiry(
      "2026-06-23T12:01:00.000Z",
      Date.parse("2026-06-23T12:00:30.000Z")
    ),
    30
  );
  assert.equal(
    secondsUntilEntryTokenExpiry(
      "2026-06-23T12:01:00.000Z",
      Date.parse("2026-06-23T12:01:01.000Z")
    ),
    0
  );
});

test("stale resident access entry token errors request one heartbeat retry", () => {
  const error = new Error("Resident access needs to be refreshed");
  error.reason = "resident_access_stale";

  assert.equal(shouldRetryEntryTokenAfterHeartbeat(error), true);
  assert.equal(shouldRetryEntryTokenAfterHeartbeat(new Error("Other failure")), false);
});
