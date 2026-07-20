
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildResidentProvision,
  getResidentGuestPassEligibility,
  getResidentHeartbeatNextCheckAfter,
  validateResmanHeartbeatAccess,
} = require("../lib/residents");

test("buildResidentProvision creates a resident row from verified ResMan access without session material", () => {
  const provision = buildResidentProvision({
    username: "Bbloch01",
    portalAccess: {
      allowed: true,
      ledgerId: "lease-ledger-id",
      tenantName: "BENJAMIN BLOCH",
      unitNumber: "1726 ST-4",
      status: "Under Eviction",
    },
    verifiedAt: "2026-06-23T12:00:00.000Z",
  });

  assert.deepEqual(provision, {
    resman_ledger_id: "lease-ledger-id",
    resman_login: "bbloch01",
    name: "BENJAMIN BLOCH",
    unit_id: "1726 ST-4",
    access_allowed: true,
    access_status: "Under Eviction",
    last_resman_verified_at: "2026-06-23T12:00:00.000Z",
  });

  assert.equal("resmanSession" in provision, false);
  assert.equal("cookieHeader" in provision, false);
  assert.equal("cookies" in provision, false);
});

test("validateResmanHeartbeatAccess requires allowed access and matching ledger id", () => {
  assert.deepEqual(
    validateResmanHeartbeatAccess({
      tokenLedgerId: "lease-ledger-id",
      portalAccess: {
        allowed: true,
        ledgerId: "lease-ledger-id",
        unitNumber: "1726 ST-4",
        status: "Current",
      },
    }),
    { valid: true }
  );

  assert.deepEqual(
    validateResmanHeartbeatAccess({
      tokenLedgerId: "lease-ledger-id",
      portalAccess: {
        allowed: true,
        ledgerId: "other-ledger-id",
        unitNumber: "1726 ST-4",
        status: "Current",
      },
    }),
    { valid: false, status: 401, reason: "resman_ledger_mismatch" }
  );

  assert.deepEqual(
    validateResmanHeartbeatAccess({
      tokenLedgerId: "lease-ledger-id",
      portalAccess: {
        allowed: false,
        ledgerId: "lease-ledger-id",
        unitNumber: "1726 ST-4",
        status: "Former",
      },
    }),
    { valid: false, status: 403, reason: "resident_status_not_allowed" }
  );

  assert.deepEqual(
    validateResmanHeartbeatAccess({
      tokenLedgerId: "lease-ledger-id",
      portalAccess: {
        allowed: false,
        ledgerId: "other-ledger-id",
        unitNumber: "1726 ST-4",
        status: "Former",
      },
    }),
    { valid: false, status: 401, reason: "resman_ledger_mismatch" }
  );

  assert.deepEqual(
    validateResmanHeartbeatAccess({
      tokenLedgerId: "lease-ledger-id",
      portalAccess: { allowed: false, error: "transactions_unavailable" },
    }),
    { valid: false, status: 403, reason: "transactions_unavailable" }
  );
});

test("guest pass eligibility requires a fresh allowed ResMan heartbeat", () => {
  const now = Date.parse("2026-06-23T12:00:00.000Z");

  assert.deepEqual(
    getResidentGuestPassEligibility({
      access_allowed: true,
      last_resman_verified_at: "2026-06-23T11:55:00.000Z",
    }, now, 20 * 60 * 1000),
    { allowed: true }
  );
  assert.deepEqual(
    getResidentGuestPassEligibility({
      access_allowed: true,
      last_resman_verified_at: "2026-06-23T11:00:00.000Z",
    }, now, 20 * 60 * 1000),
    { allowed: false, reason: "resident_access_stale" }
  );
  assert.deepEqual(
    getResidentGuestPassEligibility({
      access_allowed: false,
      access_status: "Former",
      last_resman_verified_at: "2026-06-23T11:59:00.000Z",
    }, now, 20 * 60 * 1000),
    { allowed: false, reason: "resident_access_denied", status: "Former" }
  );
});

test("heartbeat next check hints leave a safety margin before access becomes stale", () => {
  assert.equal(
    getResidentHeartbeatNextCheckAfter(
      Date.parse("2026-06-23T12:00:00.000Z"),
      20 * 60 * 1000
    ),
    "2026-06-23T12:10:00.000Z"
  );
});
