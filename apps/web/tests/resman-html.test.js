const assert = require("node:assert/strict");
const test = require("node:test");

const {
  decodeHtmlEntities,
  splitSetCookieHeader,
  getSetCookieHeaders,
  hiddenInputValue,
  extractRequestVerificationToken,
} = require("../lib/resman-html");

test("decodeHtmlEntities decodes the five entities ResMan emits", () => {
  assert.equal(
    decodeHtmlEntities("D&#39;Angelo O&amp;B &lt;LLC&gt; &quot;Court&quot;"),
    "D'Angelo O&B <LLC> \"Court\""
  );
  // No entities → passthrough.
  assert.equal(decodeHtmlEntities("plain value"), "plain value");
});

test("splitSetCookieHeader splits multiple cookies without breaking on Expires commas", () => {
  const header =
    "a=1; path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT; secure, b=2; path=/; HttpOnly";
  assert.deepEqual(splitSetCookieHeader(header), [
    "a=1; path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT; secure",
    "b=2; path=/; HttpOnly",
  ]);
});

test("splitSetCookieHeader returns a single cookie unchanged and drops empties", () => {
  assert.deepEqual(splitSetCookieHeader("only=1; path=/"), ["only=1; path=/"]);
  assert.deepEqual(splitSetCookieHeader(""), []);
});

test("getSetCookieHeaders prefers getSetCookie() when present", () => {
  const fake = {
    getSetCookie: () => ["a=1; path=/", "b=2; path=/"],
    get: () => {
      throw new Error("should not fall back when getSetCookie returns values");
    },
  };
  assert.deepEqual(getSetCookieHeaders(fake), ["a=1; path=/", "b=2; path=/"]);
});

test("getSetCookieHeaders falls back to splitting the combined header", () => {
  const fake = {
    getSetCookie: () => [],
    get: (name) => (name === "set-cookie" ? "a=1; path=/, b=2; path=/" : null),
  };
  assert.deepEqual(getSetCookieHeaders(fake), ["a=1; path=/", "b=2; path=/"]);
});

test("getSetCookieHeaders returns [] when there are no cookies at all", () => {
  const fake = { getSetCookie: () => [], get: () => null };
  assert.deepEqual(getSetCookieHeaders(fake), []);
});

test("hiddenInputValue reads a value tolerant of attribute order and quotes", () => {
  assert.equal(
    hiddenInputValue('<input name="LoggedInUser" value="bbloch" />', "LoggedInUser"),
    "bbloch"
  );
  assert.equal(
    hiddenInputValue("<input value='jsmith' name='LoggedInUser'>", "LoggedInUser"),
    "jsmith"
  );
  assert.equal(hiddenInputValue("<input name='Other' value='x'>", "LoggedInUser"), null);
});

test("extractRequestVerificationToken matches hidden-input and meta-tag forms", () => {
  assert.equal(
    extractRequestVerificationToken(
      '<input name="__RequestVerificationToken" type="hidden" value="tok-1" />'
    ),
    "tok-1"
  );
  assert.equal(
    extractRequestVerificationToken(
      '<input value="tok-2" name="__RequestVerificationToken" />'
    ),
    "tok-2"
  );
  assert.equal(
    extractRequestVerificationToken(
      `<meta name="RequestVerificationToken" content="tok-3">`
    ),
    "tok-3"
  );
  assert.equal(extractRequestVerificationToken("<p>no token here</p>"), null);
});
