const assert = require("node:assert/strict");
const test = require("node:test");

const { formatShortDateTime } = require("../dist");

// Rendered hour depends on the machine timezone (matching the consumer apps),
// and the date/time connector depends on the JS engine's Intl (ICU) data:
// V8/Node emits "Jun 24, 7:00 AM" while JSC/Bun emits "Jun 24 at 7:00 AM".
// Consumer apps run on Node (web) and Hermes (mobile), not Bun, so their output
// is unchanged; this test only needs to tolerate whichever engine runs it.
// Assert the recipe's shape rather than a fixed hour or connector.
const SHORT_RECIPE = /^Jun 2[34](,| at) \d{1,2}:00 [AP]M$/;

test("formatShortDateTime renders the shared en-US short recipe", () => {
  assert.match(formatShortDateTime("2026-06-24T12:00:00.000Z"), SHORT_RECIPE);
});

test("formatShortDateTime returns the fallback for unparseable input when provided", () => {
  assert.equal(formatShortDateTime("not-a-date", "Unknown"), "Unknown");
  assert.equal(formatShortDateTime("", "Unknown"), "Unknown");
});

test("formatShortDateTime without a fallback keeps the raw locale output", () => {
  assert.equal(formatShortDateTime("not-a-date"), "Invalid Date");
});

test("formatShortDateTime ignores the fallback for valid input", () => {
  assert.match(formatShortDateTime("2026-06-24T12:00:00.000Z", "Unknown"), SHORT_RECIPE);
});
