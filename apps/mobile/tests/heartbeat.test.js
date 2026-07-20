
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  classifyHeartbeatFailure,
  shouldRunHeartbeat,
  shouldLogoutForHeartbeatResult,
} = require("../lib/sessionHeartbeat");

test("heartbeat network failures do not force logout", () => {
  assert.equal(classifyHeartbeatFailure(undefined), "unknown");
  assert.equal(shouldLogoutForHeartbeatResult("unknown"), false);
});

test("heartbeat auth and access failures force logout", () => {
  assert.equal(classifyHeartbeatFailure(401), "invalid");
  assert.equal(classifyHeartbeatFailure(403), "invalid");
  assert.equal(shouldLogoutForHeartbeatResult("invalid"), true);
  assert.equal(shouldLogoutForHeartbeatResult({ status: "invalid" }), true);
});

test("heartbeat scheduling respects server next-check hints", () => {
  const now = Date.parse("2026-06-23T12:00:00.000Z");

  assert.equal(shouldRunHeartbeat(null, now), true);
  assert.equal(shouldRunHeartbeat("2026-06-23T12:10:00.000Z", now), false);
  assert.equal(shouldRunHeartbeat("2026-06-23T11:59:00.000Z", now), true);
});

test("auth provider verifies restored ResMan sessions before clearing cold-launch loading state", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/auth.tsx"), "utf8");
  const restoreBlock = source.slice(source.indexOf("Restore session on cold launch"), source.indexOf("Emberly session verification"));
  const heartbeatIndex = restoreBlock.indexOf("verifySession(storedToken");
  const loadingIndex = restoreBlock.indexOf("setIsLoading(false)");

  assert.notEqual(heartbeatIndex, -1);
  assert.notEqual(loadingIndex, -1);
  assert.equal(heartbeatIndex < loadingIndex, true);
});

test("root layout shows a verification message while auth is loading", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "app/_layout.tsx"), "utf8");

  assert.equal(source.includes("Verifying access..."), true);
  assert.equal(source.includes("Checking your ResMan session before loading passes."), true);
});
