const assert = require("node:assert/strict");
const test = require("node:test");

const { getGuestPassStatus } = require("../dist");

const NOW = new Date("2026-06-23T12:00:00.000Z");
const FUTURE = "2026-06-24T12:00:00.000Z";
const PAST = "2026-06-22T12:00:00.000Z";

test("revoked wins over every other signal", () => {
  assert.equal(
    getGuestPassStatus(
      { status: "revoked", used_at: "2026-06-23T11:00:00.000Z", expires_at: PAST },
      NOW
    ),
    "revoked"
  );
});

test("used wins over expired, from timestamp, status, or used flag", () => {
  assert.equal(
    getGuestPassStatus({ status: "active", used_at: "2026-06-23T11:00:00.000Z", expires_at: PAST }, NOW),
    "used"
  );
  assert.equal(
    getGuestPassStatus({ status: "used", used_at: null, expires_at: PAST }, NOW),
    "used"
  );
  assert.equal(
    getGuestPassStatus({ status: "active", used: true, expires_at: PAST }, NOW),
    "used"
  );
});

test("camelCase input shapes are accepted", () => {
  assert.equal(
    getGuestPassStatus({ status: "active", usedAt: "2026-06-23T11:00:00.000Z", expiresAt: FUTURE }, NOW),
    "used"
  );
  assert.equal(
    getGuestPassStatus({ status: "active", usedAt: null, expiresAt: PAST }, NOW),
    "expired"
  );
});

test("separates active and expired passes by expiry against now", () => {
  assert.equal(
    getGuestPassStatus({ status: "active", used_at: null, expires_at: FUTURE }, NOW),
    "active"
  );
  assert.equal(
    getGuestPassStatus({ status: "active", used_at: null, expires_at: PAST }, NOW),
    "expired"
  );
});

test("missing or invalid expiry does not force expiry", () => {
  assert.equal(getGuestPassStatus({ status: "active" }, NOW), "active");
  assert.equal(
    getGuestPassStatus({ status: "active", used_at: null, expires_at: "not-a-date" }, NOW),
    "active"
  );
});

test("a server-reported expired status is preserved", () => {
  assert.equal(
    getGuestPassStatus({ status: "expired", used_at: null, expires_at: FUTURE }, NOW),
    "expired"
  );
});

test("missing status defaults to active", () => {
  assert.equal(getGuestPassStatus({ expires_at: FUTURE }, NOW), "active");
});

test("now defaults to the current time", () => {
  assert.equal(getGuestPassStatus({ status: "active", expires_at: PAST }), "expired");
});
