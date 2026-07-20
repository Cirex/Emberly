
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  classifyVerifyPassToken,
  extractGuestShareTokenFromQr,
} = require("../lib/verify-pass-tokens");

test("classifyVerifyPassToken keeps signed resident and guest entry tokens intact", () => {
  assert.deepEqual(
    classifyVerifyPassToken(" emberly://resident/signed-token "),
    { type: "resident-entry", parsed: "emberly://resident/signed-token" }
  );
  assert.deepEqual(
    classifyVerifyPassToken("emberly://guest-entry/signed-token"),
    { type: "guest-entry", parsed: "emberly://guest-entry/signed-token" }
  );
});

test("classifyVerifyPassToken accepts guest pass share URLs scanned from QR codes", () => {
  assert.deepEqual(
    classifyVerifyPassToken("https://emberly.example.com/guest-pass/share-token-1"),
    { type: "guest-share", parsed: "share-token-1" }
  );
  assert.deepEqual(
    classifyVerifyPassToken("http://192.168.0.178:3001/guest-pass/token%2Fwith%20space"),
    { type: "guest-share", parsed: "token/with space" }
  );
  assert.deepEqual(
    classifyVerifyPassToken("/guest-pass/local-share-token"),
    { type: "guest-share", parsed: "local-share-token" }
  );
});

test("extractGuestShareTokenFromQr rejects unrelated URLs and raw unsupported values", () => {
  assert.equal(extractGuestShareTokenFromQr("https://emberly.example.com/admin"), null);
  assert.equal(extractGuestShareTokenFromQr("not-a-qr-format"), null);
  assert.deepEqual(
    classifyVerifyPassToken("not-a-qr-format"),
    { type: "unknown", parsed: "not-a-qr-format" }
  );
});
