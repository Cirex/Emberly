const assert = require("node:assert/strict");
const test = require("node:test");

const { extractLoggedInIdentity } = require("../lib/resman-admin-login");

// A trimmed shape of the authenticated ResMan app page: the identity lives in
// a block of hidden inputs, and the person GUID is also echoed as a JS var.
const LANDED_PAGE = `
<!DOCTYPE html><html><body>
  <form>
    <input type="hidden" name="LoggedInUser" value="bbloch" />
    <input type="hidden" name="LoggedInPersonName" value="Ben Bloch" />
    <input type="hidden" name="LoggedInPersonID" value="b78d380f-63e9-43c0-aab8-f75b906cb27e" />
  </form>
  <script>window.personID = "b78d380f-63e9-43c0-aab8-f75b906cb27e";</script>
</body></html>`;

test("extractLoggedInIdentity reads the hidden-input staff identity", () => {
  const id = extractLoggedInIdentity(LANDED_PAGE);
  assert.equal(id.personId, "b78d380f-63e9-43c0-aab8-f75b906cb27e");
  assert.equal(id.personName, "Ben Bloch");
  assert.equal(id.shortName, "bbloch");
});

test("extractLoggedInIdentity tolerates reversed attribute order and single quotes", () => {
  const html = `<input value='jsmith' name='LoggedInUser'>
    <input value="Jane Smith" name="LoggedInPersonName">
    <input value='0f-guid' name='LoggedInPersonID'>`;
  const id = extractLoggedInIdentity(html);
  assert.equal(id.shortName, "jsmith");
  assert.equal(id.personName, "Jane Smith");
  assert.equal(id.personId, "0f-guid");
});

test("extractLoggedInIdentity decodes HTML entities in the display name", () => {
  const html = `<input name="LoggedInPersonName" value="D&#39;Angelo O&amp;B" />`;
  assert.equal(extractLoggedInIdentity(html).personName, "D'Angelo O&B");
});

test("extractLoggedInIdentity falls back to window.personID when the hidden input is absent", () => {
  const html = `<input name="LoggedInUser" value="bbloch" />
    <script>var personID = "fallback-guid";</script>`;
  const id = extractLoggedInIdentity(html);
  assert.equal(id.personId, "fallback-guid");
  assert.equal(id.shortName, "bbloch");
  assert.equal(id.personName, null);
});

test("extractLoggedInIdentity returns nulls when nothing matches", () => {
  const id = extractLoggedInIdentity("<html><body>signed out</body></html>");
  assert.deepEqual(id, { personId: null, personName: null, shortName: null });
});
