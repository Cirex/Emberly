const { test } = require("node:test");
const assert = require("node:assert");

// Placeholder so `turbo test` has a passing target in this workspace. Real
// component/logic tests arrive with each feature phase (Jest/RNTL under Expo).
test("smoke: test runner is wired", () => {
  assert.equal(1 + 1, 2);
});
