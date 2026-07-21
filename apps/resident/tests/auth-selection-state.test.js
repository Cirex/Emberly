
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

test("login screen does not serialize raw ResMan session into navigation params", () => {
  const loginSource = fs.readFileSync(
    path.join(process.cwd(), "app/(auth)/login.tsx"),
    "utf8"
  );
  const selectSource = fs.readFileSync(
    path.join(process.cwd(), "app/(auth)/select-resident.tsx"),
    "utf8"
  );

  assert.equal(loginSource.includes("JSON.stringify(result.resmanSession)"), false);
  assert.equal(selectSource.includes("resmanSessionJson"), false);
  assert.equal(selectSource.includes("JSON.parse(resmanSessionJson)"), false);
});
