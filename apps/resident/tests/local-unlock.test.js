
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getLocalUnlockAvailability,
  getLocalUnlockLabel,
  shouldLockAppForLocalUnlock,
} = require("../lib/localUnlock");

test("local unlock prefers Face ID when facial recognition is available", () => {
  assert.equal(getLocalUnlockLabel([1, 2]), "Face ID");
});

test("local unlock reports unavailable when biometric hardware is missing", () => {
  const availability = getLocalUnlockAvailability({
    hasHardware: false,
    isEnrolled: false,
    authenticationTypes: [],
  });

  assert.equal(availability.available, false);
  assert.equal(availability.label, "Device unlock");
  assert.match(availability.unavailableReason, /not available/);
});

test("local unlock only locks an active session when enabled", () => {
  assert.equal(shouldLockAppForLocalUnlock(true, true), true);
  assert.equal(shouldLockAppForLocalUnlock(false, true), false);
  assert.equal(shouldLockAppForLocalUnlock(true, false), false);
});
