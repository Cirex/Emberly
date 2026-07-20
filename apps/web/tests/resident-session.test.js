process.env.API_SECRET_KEY = "test-secret";


const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createResidentEntryToken,
  createResidentSelectionToken,
  createResidentSession,
  verifyResidentEntryToken,
  verifyResidentSelectionToken,
  verifyToken,
} = require("../lib/auth");

test("createResidentSession returns resident identity with an expiring signed token", () => {
  const session = createResidentSession(
    {
      id: "resident-uuid",
      resman_ledger_id: "eaf93329-91f0-4922-8074-18852a405d1c",
      name: "Benjamin Bloch",
      unit_id: "2103",
    },
    { now: Date.parse("2026-06-20T12:00:00.000Z") }
  );

  assert.equal(session.resident.residentId, "resident-uuid");
  assert.equal(session.resident.ledgerId, "eaf93329-91f0-4922-8074-18852a405d1c");
  // The resident app reads `tenantId` for the ledger id; keep emitting it.
  assert.equal(session.resident.tenantId, "eaf93329-91f0-4922-8074-18852a405d1c");
  assert.equal(session.resident.unitNumber, "2103");
  assert.equal(session.expiresAt, "2026-07-20T12:00:00.000Z");

  // Pin the clock to just after issuance so this doesn't become a time bomb
  // once the token's 30-day window elapses in real time.
  const payload = verifyToken(session.token, Date.parse("2026-06-20T12:00:01.000Z"));
  assert.equal(payload.ledgerId, "eaf93329-91f0-4922-8074-18852a405d1c");
  assert.equal(payload.residentId, "resident-uuid");
  assert.equal(payload.unitNumber, "2103");
  assert.equal(payload.exp, Date.parse("2026-07-20T12:00:00.000Z"));
});

test("verifyToken rejects tokens without an expiry", () => {
  const { createHmac } = require("node:crypto");
  const encoded = Buffer.from(
    JSON.stringify({ ledgerId: "ledger-1", residentId: "resident-uuid", iat: Date.now() })
  ).toString("base64url");
  const signature = createHmac("sha256", "test-secret").update(encoded).digest("base64url");

  assert.equal(verifyToken(`${encoded}.${signature}`), null);
});

test("resident entry tokens are signed, short lived, and scoped to a resident", () => {
  const token = createResidentEntryToken(
    {
      residentId: "resident-uuid",
      unitNumber: "2103",
      deviceId: "device-1",
    },
    { now: Date.parse("2026-06-20T12:00:00.000Z"), ttlMs: 60_000 }
  );

  const valid = verifyResidentEntryToken(token, Date.parse("2026-06-20T12:00:30.000Z"));
  assert.equal(valid?.kind, "resident-entry");
  assert.equal(valid?.residentId, "resident-uuid");
  assert.equal(valid?.deviceId, "device-1");
  assert.equal(valid?.unitNumber, "2103");

  assert.equal(
    verifyResidentEntryToken(token, Date.parse("2026-06-20T12:01:01.000Z")),
    null
  );
});

test("resident selection tokens are signed, short lived, and scoped to allowed residents", () => {
  const selectionToken = createResidentSelectionToken(
    {
      username: "bbloch01",
      ledgerId: "eaf93329-91f0-4922-8074-18852a405d1c",
      residentIds: ["resident-1", "resident-2"],
    },
    { now: Date.parse("2026-06-20T12:00:00.000Z") }
  );

  const valid = verifyResidentSelectionToken(
    selectionToken,
    "resident-2",
    Date.parse("2026-06-20T12:05:00.000Z")
  );
  assert.equal(valid?.username, "bbloch01");
  assert.equal(valid?.ledgerId, "eaf93329-91f0-4922-8074-18852a405d1c");
  assert.deepEqual(valid?.residentIds, ["resident-1", "resident-2"]);

  assert.equal(
    verifyResidentSelectionToken(
      selectionToken,
      "resident-3",
      Date.parse("2026-06-20T12:05:00.000Z")
    ),
    null
  );
  assert.equal(
    verifyResidentSelectionToken(
      selectionToken,
      "resident-1",
      Date.parse("2026-06-20T12:16:00.000Z")
    ),
    null
  );
});
