process.env.API_SECRET_KEY = "api-secret-for-tests";
process.env.ADMIN_SESSION_SECRET = "admin-session-secret-for-tests";
// Deliberately set the RETIRED env scanner keys: a regression guard below proves
// they no longer authenticate anything (scanner_devices is the sole key source).
process.env.SCANNER_API_KEY = "scanner-secret-for-tests";
process.env.SCANNER_KEYS = JSON.stringify({
  gate_a: "gate-a-secret-for-tests",
  gate_b: "gate-b-secret-for-tests",
});
process.env.RESMAN_PORTAL_ORIGIN = "https://multisouth.myresman.com";


const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createAdminSessionToken,
  createGuestEntryToken,
  createSignedResmanPortalSession,
  createResidentEntryToken,
  createResidentSelectionToken,
  createResidentSession,
  verifyAdminKey,
  readAdminSessionToken,
  verifyGuestEntryToken,
  verifySignedResmanPortalSession,
} = require("../lib/auth");
const {
  isAllowedResmanPortalSession,
} = require("../lib/resman-portal");
const {
  createScannerSecret,
  getAuthenticatedScannerFromDatabase,
  hashScannerSecret,
  rateLimitScannerAttempt,
  verifyScannerSecretHash,
} = require("../lib/scanner-auth");
const {
  isResidentAccessFresh,
  buildResidentAccessUpdate,
} = require("../lib/residents");
const {
  checkMemoryRateLimit,
  shouldFailClosedOnDurableRateLimitFailure,
} = require("../lib/rate-limit");
const {
  createResidentDeviceSession,
  revokeResidentDeviceSessions,
  verifyResidentDeviceSession,
} = require("../lib/resident-devices");

test("admin auth uses a signed session cookie instead of accepting the raw admin key cookie", async () => {
  const token = createAdminSessionToken({ now: Date.now() });
  // readAdminSessionToken returns the admin context (or null); a valid signed
  // session resolves to a context.
  assert.ok(readAdminSessionToken(token, Date.parse("2026-06-23T13:00:00.000Z")));

  assert.equal(
    await verifyAdminKey(new Request("https://emberly.test/api/admin/residents", {
      headers: { cookie: `emberly_admin_session=${token}` },
    })),
    true
  );
  assert.equal(
    await verifyAdminKey(new Request("https://emberly.test/api/admin/residents", {
      headers: { cookie: "emberly_admin_key=api-secret-for-tests" },
    })),
    false
  );
});

test("admin session tokens expire", () => {
  const token = createAdminSessionToken({ now: Date.parse("2026-06-23T12:00:00.000Z") });

  // Within the 8h window it resolves to a context; past expiry it returns null.
  assert.ok(readAdminSessionToken(token, Date.parse("2026-06-23T19:59:59.000Z")));
  assert.equal(
    readAdminSessionToken(token, Date.parse("2026-06-23T20:00:01.000Z")),
    null
  );
});

test("ResMan session origins are restricted to the configured portal origin", () => {
  assert.equal(
    isAllowedResmanPortalSession({
      baseUrl: "https://multisouth.myresman.com",
      signInUrl: "https://multisouth.myresman.com/Portal/Access/SignIn/Emberly",
      cookieHeader: "PortalAuthorizationCookie=session",
      cookies: [],
      issuedAt: "2026-06-23T12:00:00.000Z",
    }),
    true
  );
  assert.equal(
    isAllowedResmanPortalSession({
      baseUrl: "https://attacker.example",
      signInUrl: "https://attacker.example/login",
      cookieHeader: "PortalAuthorizationCookie=session",
      cookies: [],
      issuedAt: "2026-06-23T12:00:00.000Z",
    }),
    false
  );
});

test("ResMan heartbeat sessions are signed and reject tampered cookies", () => {
  const signed = createSignedResmanPortalSession({
    baseUrl: "https://multisouth.myresman.com",
    signInUrl: "https://multisouth.myresman.com/Portal/Access/SignIn/Emberly",
    cookieHeader: "PortalAuthorizationCookie=session",
    cookies: [{
      name: "PortalAuthorizationCookie",
      value: "session",
      domain: "multisouth.myresman.com",
      path: "/",
      secure: true,
      httpOnly: true,
    }],
    issuedAt: "2026-06-23T12:00:00.000Z",
  });

  assert.equal(
    verifySignedResmanPortalSession(
      signed,
      Date.parse("2026-06-23T12:01:00.000Z")
    )?.cookieHeader,
    "PortalAuthorizationCookie=session"
  );
  assert.equal(
    verifySignedResmanPortalSession({
      ...signed,
      cookieHeader: "PortalAuthorizationCookie=attacker",
    }),
    null
  );
});

test("ResMan heartbeat session signatures expire independently", () => {
  const signed = createSignedResmanPortalSession({
    baseUrl: "https://multisouth.myresman.com",
    signInUrl: "https://multisouth.myresman.com/Portal/Access/SignIn/Emberly",
    cookieHeader: "PortalAuthorizationCookie=session",
    cookies: [],
    issuedAt: "2026-06-23T12:00:00.000Z",
  });

  assert.equal(
    verifySignedResmanPortalSession(
      signed,
      Date.parse("2026-06-23T12:59:59.000Z"),
      60 * 60 * 1000
    )?.cookieHeader,
    "PortalAuthorizationCookie=session"
  );
  assert.equal(
    verifySignedResmanPortalSession(
      signed,
      Date.parse("2026-06-23T13:00:01.000Z"),
      60 * 60 * 1000
    ),
    null
  );
});

test("invalid ResMan session signature max-age configuration does not disable expiry", () => {
  const original = process.env.RESMAN_SESSION_SIGNATURE_MAX_AGE_MS;
  process.env.RESMAN_SESSION_SIGNATURE_MAX_AGE_MS = "not-a-number";
  try {
    const signed = createSignedResmanPortalSession({
      baseUrl: "https://multisouth.myresman.com",
      signInUrl: "https://multisouth.myresman.com/Portal/Access/SignIn/Emberly",
      cookieHeader: "PortalAuthorizationCookie=session",
      cookies: [],
      issuedAt: "2026-06-23T12:00:00.000Z",
    });

    assert.equal(
      verifySignedResmanPortalSession(signed, Date.parse("2026-07-01T12:00:01.000Z")),
      null
    );
  } finally {
    if (original === undefined) {
      delete process.env.RESMAN_SESSION_SIGNATURE_MAX_AGE_MS;
    } else {
      process.env.RESMAN_SESSION_SIGNATURE_MAX_AGE_MS = original;
    }
  }
});

test("production token signing requires scoped secrets instead of API_SECRET_KEY fallback", () => {
  const originals = {
    NODE_ENV: process.env.NODE_ENV,
    RESIDENT_SESSION_SECRET: process.env.RESIDENT_SESSION_SECRET,
    SELECTION_TOKEN_SECRET: process.env.SELECTION_TOKEN_SECRET,
    RESIDENT_ENTRY_TOKEN_SECRET: process.env.RESIDENT_ENTRY_TOKEN_SECRET,
    GUEST_ENTRY_TOKEN_SECRET: process.env.GUEST_ENTRY_TOKEN_SECRET,
    RESMAN_SESSION_SIGNING_SECRET: process.env.RESMAN_SESSION_SIGNING_SECRET,
    ADMIN_SESSION_SECRET: process.env.ADMIN_SESSION_SECRET,
  };

  process.env.NODE_ENV = "production";
  delete process.env.RESIDENT_SESSION_SECRET;
  delete process.env.SELECTION_TOKEN_SECRET;
  delete process.env.RESIDENT_ENTRY_TOKEN_SECRET;
  delete process.env.GUEST_ENTRY_TOKEN_SECRET;
  delete process.env.RESMAN_SESSION_SIGNING_SECRET;
  delete process.env.ADMIN_SESSION_SECRET;

  try {
    assert.throws(
      () => createResidentSession({
        id: "resident-1",
        resman_ledger_id: "ledger-1",
        name: "Resident",
        unit_id: "101",
      }),
      /RESIDENT_SESSION_SECRET/
    );
    assert.throws(
      () => createResidentSelectionToken({ username: "user", ledgerId: "ledger-1", residentIds: ["resident-1"] }),
      /SELECTION_TOKEN_SECRET/
    );
    assert.throws(
      () => createResidentEntryToken({ residentId: "resident-1", unitNumber: "101" }),
      /RESIDENT_ENTRY_TOKEN_SECRET/
    );
    assert.throws(
      () => createGuestEntryToken({ guestPassId: "guest-pass-1" }),
      /GUEST_ENTRY_TOKEN_SECRET/
    );
    assert.throws(
      () => createSignedResmanPortalSession({
        baseUrl: "https://multisouth.myresman.com",
        signInUrl: "https://multisouth.myresman.com/Portal/Access/SignIn/Emberly",
        cookieHeader: "PortalAuthorizationCookie=session",
        cookies: [],
        issuedAt: "2026-06-23T12:00:00.000Z",
      }),
      /RESMAN_SESSION_SIGNING_SECRET/
    );
    assert.throws(
      () => createAdminSessionToken({ now: Date.parse("2026-06-23T12:00:00.000Z") }),
      /ADMIN_SESSION_SECRET/
    );
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("legacy ResMan stub module is removed", () => {
  assert.equal(fs.existsSync(path.join(__dirname, "..", "lib", "resman.ts")), false);
});

test("TOTP subsystem modules are removed", () => {
  assert.equal(fs.existsSync(path.join(__dirname, "..", "lib", "totp.ts")), false);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "lib", "secret-vault.ts")), false);
});

/** Registry stub that resolves a row by scanner_id or secret_hash. */
function fakeScannerRegistry(row) {
  return {
    from(table) {
      assert.equal(table, "scanner_devices");
      return {
        select() {
          return {
            eq(column, value) {
              const match =
                row &&
                ((column === "secret_hash" && row.secret_hash === value) ||
                  (column === "scanner_id" && row.scanner_id === value));
              return {
                async maybeSingle() {
                  return { data: match ? row : null, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

const scannerRequest = (secret) =>
  new Request("https://emberly.test/api/verify-pass", {
    headers: { authorization: `Bearer ${secret}` },
  });

test("a registry scanner key self-identifies without a scanner id", async () => {
  const secret = createScannerSecret();
  const registry = fakeScannerRegistry({
    scanner_id: "front-gate",
    enabled: true,
    secret_hash: hashScannerSecret(secret),
  });

  assert.deepEqual(await getAuthenticatedScannerFromDatabase(registry, scannerRequest(secret)), {
    scannerId: "front-gate",
  });
  assert.equal(
    await getAuthenticatedScannerFromDatabase(registry, scannerRequest(createScannerSecret())),
    null
  );
});

test("a disabled registry scanner cannot authenticate", async () => {
  const secret = createScannerSecret();
  const registry = fakeScannerRegistry({
    scanner_id: "front-gate",
    enabled: false,
    secret_hash: hashScannerSecret(secret),
  });

  assert.equal(await getAuthenticatedScannerFromDatabase(registry, scannerRequest(secret)), null);
  assert.equal(
    await getAuthenticatedScannerFromDatabase(registry, scannerRequest(secret), "front-gate"),
    null
  );
});

test("env scanner keys are ignored — scanner_devices is the sole key source", async () => {
  // SCANNER_API_KEY / SCANNER_KEYS are still set at the top of this file. They
  // must not authenticate anything: the env key paths were removed.
  const emptyRegistry = fakeScannerRegistry(null);

  for (const legacySecret of ["scanner-secret-for-tests", "gate-a-secret-for-tests"]) {
    assert.equal(
      await getAuthenticatedScannerFromDatabase(emptyRegistry, scannerRequest(legacySecret)),
      null
    );
    assert.equal(
      await getAuthenticatedScannerFromDatabase(emptyRegistry, scannerRequest(legacySecret), "gate_a"),
      null
    );
  }
});

test("database scanner credentials are hashed and bound to scanner id", async () => {
  const scannerSecret = createScannerSecret();
  const secretHash = hashScannerSecret(scannerSecret);
  assert.match(secretHash, /^hmac-sha256:/);
  assert.equal(verifyScannerSecretHash(scannerSecret, secretHash), true);
  assert.equal(verifyScannerSecretHash("wrong-secret", secretHash), false);

  const supabase = {
    from(table) {
      assert.equal(table, "scanner_devices");
      return {
        select() {
          return {
            eq(_column, scannerId) {
              return {
                async maybeSingle() {
                  return {
                    data: scannerId === "gate_db"
                      ? { scanner_id: "gate_db", enabled: true, secret_hash: secretHash }
                      : null,
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  assert.deepEqual(
    await getAuthenticatedScannerFromDatabase(
      supabase,
      new Request("https://emberly.test/api/verify-pass", {
        headers: { authorization: `Bearer ${scannerSecret}` },
      }),
      "gate_db"
    ),
    { scannerId: "gate_db" }
  );
  assert.equal(
    await getAuthenticatedScannerFromDatabase(
      supabase,
      new Request("https://emberly.test/api/verify-pass", {
        headers: { authorization: `Bearer ${scannerSecret}` },
      }),
      "other_gate"
    ),
    null
  );
});

test("scanner verification rejects legacy non-HMAC sha256 hashes", () => {
  const scannerSecret = createScannerSecret();
  const legacyHash = require("node:crypto").createHash("sha256").update(scannerSecret).digest("hex");

  assert.match(hashScannerSecret(scannerSecret), /^hmac-sha256:/);
  assert.equal(verifyScannerSecretHash(scannerSecret, legacyHash), false);
  assert.equal(verifyScannerSecretHash("wrong-secret", legacyHash), false);
});

test("scanner rate limiting keys signed resident entry attempts by scanner and token fingerprint", () => {
  for (let index = 0; index < 60; index++) {
    assert.equal(
      rateLimitScannerAttempt("gate_a:resident-entry:fingerprint-1", Date.parse("2026-06-23T12:00:00.000Z")),
      true
    );
  }

  assert.equal(
    rateLimitScannerAttempt("gate_a:resident-entry:fingerprint-1", Date.parse("2026-06-23T12:00:01.000Z")),
    false
  );
  assert.equal(
    rateLimitScannerAttempt("gate_a:resident-entry:fingerprint-2", Date.parse("2026-06-23T12:00:01.000Z")),
    true
  );
});

test("resident scanner access requires a fresh allowed ResMan heartbeat", () => {
  const now = Date.parse("2026-06-23T12:00:00.000Z");

  assert.equal(
    isResidentAccessFresh({
      access_allowed: true,
      last_resman_verified_at: "2026-06-23T11:50:00.000Z",
    }, now, 20 * 60 * 1000),
    true
  );
  assert.equal(
    isResidentAccessFresh({
      access_allowed: true,
      last_resman_verified_at: "2026-06-23T11:30:00.000Z",
    }, now, 20 * 60 * 1000),
    false
  );
  assert.equal(
    isResidentAccessFresh({
      access_allowed: false,
      last_resman_verified_at: "2026-06-23T11:59:00.000Z",
    }, now, 20 * 60 * 1000),
    false
  );
});

test("resident entry qr tokens are signed entry tokens", () => {
  const token = createResidentEntryToken(
    {
      residentId: "resident-1",
      unitNumber: "1726 ST-4",
      deviceId: "device-1",
    },
    { now: Date.parse("2026-06-23T12:00:00.000Z") }
  );

  assert.match(token, /^emberly:\/\/resident\//);
});

test("resident heartbeat updates are only built after validated ResMan access", () => {
  const portalAccess = {
    allowed: true,
    ledgerId: "lease-ledger-id",
    tenantName: "BENJAMIN BLOCH",
    unitNumber: "1726 ST-4",
    status: "Current",
  };

  assert.deepEqual(
    buildResidentAccessUpdate(
      { valid: true },
      portalAccess,
      "2026-06-23T12:00:00.000Z"
    ),
    {
      name: "BENJAMIN BLOCH",
      access_allowed: true,
      access_status: "Current",
      last_resman_verified_at: "2026-06-23T12:00:00.000Z",
    }
  );

  assert.equal(
    buildResidentAccessUpdate(
      { valid: false, status: 401, reason: "resman_ledger_mismatch" },
      portalAccess,
      "2026-06-23T12:00:00.000Z"
    ),
    null
  );
});

test("resident heartbeat persists explicit ResMan denials but not ambiguous outcomes", () => {
  const deniedPortalAccess = {
    allowed: false,
    ledgerId: "lease-ledger-id",
    tenantName: "BENJAMIN BLOCH",
    unitNumber: "1726 ST-4",
    status: "Former",
  };

  assert.deepEqual(
    buildResidentAccessUpdate(
      { valid: false, status: 403, reason: "resident_status_not_allowed" },
      deniedPortalAccess,
      "2026-06-23T12:00:00.000Z"
    ),
    {
      access_allowed: false,
      access_status: "Former",
      last_resman_verified_at: "2026-06-23T12:00:00.000Z",
    }
  );

  assert.equal(
    buildResidentAccessUpdate(
      { valid: false, status: 403, reason: "transactions_unavailable" },
      { allowed: false, error: "transactions_unavailable" },
      "2026-06-23T12:00:00.000Z"
    ),
    null
  );
});

test("guest entry qr tokens are signed and expire", () => {
  const token = createGuestEntryToken(
    { guestPassId: "guest-pass-1" },
    { now: Date.parse("2026-06-23T12:00:00.000Z"), ttlMs: 60_000, jti: "entry-1" }
  );

  assert.match(token, /^emberly:\/\/guest-entry\//);
  assert.deepEqual(
    verifyGuestEntryToken(token, Date.parse("2026-06-23T12:00:30.000Z")),
    {
      kind: "guest-entry",
      guestPassId: "guest-pass-1",
      jti: "entry-1",
      iat: Date.parse("2026-06-23T12:00:00.000Z"),
      exp: Date.parse("2026-06-23T12:01:00.000Z"),
    }
  );
  assert.equal(verifyGuestEntryToken(token, Date.parse("2026-06-23T12:01:01.000Z")), null);
});

test("shared rate limiter blocks after the configured attempt count", async () => {
  assert.equal(
    await checkMemoryRateLimit("test:shared-rate-limit", 2, 60_000, Date.parse("2026-06-23T12:00:00.000Z")),
    true
  );
  assert.equal(
    await checkMemoryRateLimit("test:shared-rate-limit", 2, 60_000, Date.parse("2026-06-23T12:00:01.000Z")),
    true
  );
  assert.equal(
    await checkMemoryRateLimit("test:shared-rate-limit", 2, 60_000, Date.parse("2026-06-23T12:00:02.000Z")),
    false
  );
  assert.equal(
    await checkMemoryRateLimit("test:shared-rate-limit", 2, 60_000, Date.parse("2026-06-23T12:01:01.000Z")),
    true
  );
});

test("durable rate limit failures fail closed in production unless explicitly disabled", () => {
  assert.equal(shouldFailClosedOnDurableRateLimitFailure(undefined, "production"), true);
  assert.equal(shouldFailClosedOnDurableRateLimitFailure(false, "production"), false);
  assert.equal(shouldFailClosedOnDurableRateLimitFailure(undefined, "development"), false);
  assert.equal(shouldFailClosedOnDurableRateLimitFailure(true, "development"), true);
});

test("resident device sessions expire and reject stale bearer tokens", async () => {
  const rows = [];
  const supabase = {
    from(table) {
      assert.equal(table, "resident_devices");
      return {
        insert(value) {
          rows.push({ id: "device-1", ...value });
          return {
            select() {
              return {
                single: async () => ({ data: { id: "device-1" }, error: null }),
              };
            },
          };
        },
        select() {
          return {
            eq(column, value) {
              this[column] = value;
              return this;
            },
            maybeSingle: async function () {
              return {
                data: rows.find((row) => row.resident_id === this.resident_id && row.token_hash === this.token_hash) ?? null,
                error: null,
              };
            },
          };
        },
        update(value) {
          Object.assign(rows[0], value);
          return { eq: () => ({}) };
        },
      };
    },
  };

  const now = Date.parse("2026-06-23T12:00:00.000Z");
  const device = await createResidentDeviceSession(supabase, {
    residentId: "resident-1",
    userAgent: "test-agent",
    now,
    ttlMs: 1_000,
  });

  assert.deepEqual(
    await verifyResidentDeviceSession(supabase, {
      residentId: "resident-1",
      deviceToken: device.token,
      now: now + 999,
    }),
    { valid: true, deviceId: "device-1" }
  );
  assert.deepEqual(
    await verifyResidentDeviceSession(supabase, {
      residentId: "resident-1",
      deviceToken: device.token,
      now: now + 1_001,
    }),
    { valid: false }
  );
});

test("resident device revocation reports Supabase failures", async () => {
  const supabase = {
    from(table) {
      assert.equal(table, "resident_devices");
      return {
        update(value) {
          assert.deepEqual(value, { active: false });
          return {
            eq: async (column, residentId) => {
              assert.equal(column, "resident_id");
              assert.equal(residentId, "resident-1");
              return { error: { message: "permission denied" } };
            },
          };
        },
      };
    },
  };

  await assert.rejects(
    () => revokeResidentDeviceSessions(supabase, "resident-1"),
    /Failed to revoke resident device sessions/
  );
});

test("legacy guest bearer and resident TOTP scan paths are removed", () => {
  const verifyPassSource = fs.readFileSync(
    path.join(__dirname, "..", "app", "api", "verify-pass", "route.ts"),
    "utf8"
  );
  assert.equal(verifyPassSource.includes("emberly://guest/"), false);
  assert.equal(verifyPassSource.includes("hashGuestPassToken"), false);
  assert.equal(verifyPassSource.includes("verifyTOTP"), false);
  assert.equal(verifyPassSource.includes("legacyResidentTotpEnabled"), false);
  assert.equal(verifyPassSource.includes("handleGuestToken"), false);
  assert.equal(verifyPassSource.includes("handleResidentToken"), false);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "lib", "legacy-resident-totp.ts")), false);
});

test("verify pass responses expose scanner and guest pass denial reason codes", () => {
  const verifyPassSource = fs.readFileSync(
    path.join(__dirname, "..", "app", "api", "verify-pass", "route.ts"),
    "utf8"
  );

  assert.match(verifyPassSource, /reasonCode\?: string/);
  // A disabled or unauthenticated scanner is denied by authenticateScanner
  // (scanner-auth.ts rejects any row that is not `enabled`), which surfaces as
  // scanner_auth_required — the former separate "scanner_disabled" code was
  // consolidated into it.
  assert.match(verifyPassSource, /reasonCode: "scanner_auth_required"/);
  assert.match(verifyPassSource, /reasonCode: "guest_pass_revoked"/);
  assert.match(verifyPassSource, /reasonCode: "guest_pass_used"/);
  assert.match(verifyPassSource, /reasonCode: "guest_pass_expired"/);
});

test("verify pass returns entry log ids for successful scan evidence uploads", () => {
  const verifyPassSource = fs.readFileSync(
    path.join(__dirname, "..", "app", "api", "verify-pass", "route.ts"),
    "utf8"
  );

  assert.match(verifyPassSource, /entryLogId\?: string/);
  assert.match(verifyPassSource, /\.from\("entry_logs"\)\s*\.insert\(/);
  assert.match(verifyPassSource, /\.select\("id"\)/);
  assert.match(verifyPassSource, /entryLogId: guestEntryLog\.id/);
  assert.match(verifyPassSource, /entryLogId: residentEntryLog\.id/);
});

test("guest pass schema only keeps share tokens and signed entry QR flow fields", () => {
  const schema = fs.readFileSync(path.join(__dirname, "..", "lib", "supabase", "schema.sql"), "utf8");
  const guestPassesBlock = schema.match(/create table guest_passes \([\s\S]*?\n\);/)?.[0] ?? "";
  assert.equal(guestPassesBlock.includes("totp_token"), false);
  assert.equal(guestPassesBlock.includes("token_hash"), false);
  assert.equal(guestPassesBlock.includes("qr_data"), false);
  assert.equal(guestPassesBlock.includes("banned boolean"), false);
  assert.match(guestPassesBlock, /share_token text unique not null/);
  assert.match(guestPassesBlock, /email_delivery_status text not null default 'pending'/);
  assert.match(guestPassesBlock, /email_provider_id text/);
  assert.match(guestPassesBlock, /email_sent_at timestamptz/);
  assert.match(guestPassesBlock, /email_last_error text/);
  assert.match(
    guestPassesBlock,
    /status text not null default 'active' check \(status in \('active', 'revoked', 'used'\)\)/
  );
});

test("schema keeps guest pass email delivery diagnostics", () => {
  const schema = fs.readFileSync(
    path.join(__dirname, "..", "lib", "supabase", "schema.sql"),
    "utf8"
  );

  assert.match(schema, /email_delivery_status text not null default 'pending'/);
  assert.match(schema, /email_delivery_status in \('pending', 'sent', 'failed'\)/);
  assert.match(schema, /email_provider_id text/);
  assert.match(schema, /email_sent_at timestamptz/);
  assert.match(schema, /email_last_error text/);
});

test("entry log photo schema stores private scan evidence metadata", () => {
  const schema = fs.readFileSync(path.join(__dirname, "..", "lib", "supabase", "schema.sql"), "utf8");
  const entryLogPhotosBlock = schema.match(/create table entry_log_photos \([\s\S]*?\n\);/)?.[0] ?? "";

  assert.match(entryLogPhotosBlock, /entry_log_id uuid not null references entry_logs\(id\) on delete cascade/);
  assert.match(entryLogPhotosBlock, /resident_id uuid references residents\(id\) on delete set null/);
  assert.match(entryLogPhotosBlock, /guest_pass_id uuid references guest_passes\(id\) on delete set null/);
  assert.match(entryLogPhotosBlock, /entry_type text not null check \(entry_type in \('resident', 'guest'\)\)/);
  assert.match(entryLogPhotosBlock, /storage_path text not null/);
  assert.match(entryLogPhotosBlock, /content_type text not null/);
  assert.match(entryLogPhotosBlock, /byte_size integer not null check \(byte_size >= 0\)/);
  assert.match(schema, /create index entry_log_photos_entry_log_idx on entry_log_photos \(entry_log_id, created_at desc\)/);
  assert.match(schema, /create index entry_log_photos_resident_idx on entry_log_photos \(resident_id, created_at desc\)/);
  assert.match(schema, /alter table entry_log_photos enable row level security/);

  assert.match(schema, /insert into storage\.buckets \(id, name, public\)/);
  assert.match(schema, /'entry-log-photos', 'entry-log-photos', false/);
  assert.match(schema, /entry_log_photos_scanner_idx/);
});

// The emberly-resident app is a separate repo, not part of this monorepo, so
// this source-content assertion only runs where it's checked out as a sibling.
const residentRepoPresent = fs.existsSync(path.join(__dirname, "..", "..", "emberly-resident"));
(residentRepoPresent ? test : test.skip)(
  "resident app no longer normalizes legacy stored guest QR payloads",
  () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "emberly-resident", "lib", "guestPasses.ts"),
      "utf8"
    );
    assert.equal(source.includes("qr_data"), false);
  }
);
