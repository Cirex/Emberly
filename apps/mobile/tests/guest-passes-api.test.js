
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildGuestPassShareMessage,
  normalizeCreatedGuestPassResponse,
  normalizeGuestPassesResponse,
  upsertGuestPass,
} = require("../lib/guestPasses");

const NOW = new Date("2026-06-23T13:00:00.000Z");

test("normalizeGuestPassesResponse maps API response object to guest pass array", () => {
  assert.deepEqual(
    normalizeGuestPassesResponse({
      passes: [
        {
          id: "pass-1",
          guest_name: "Jane Visitor",
          guest_email: "jane@example.com",
          guest_phone: "555-0101",
          guest_address: "123 Main",
          created_at: "2026-06-23T12:00:00.000Z",
          expires_at: "2026-06-24T12:00:00.000Z",
          used_at: null,
        },
      ],
      total: 1,
    }, NOW),
    [
      {
        passId: "pass-1",
        guestName: "Jane Visitor",
        guestEmail: "jane@example.com",
        guestPhone: "555-0101",
        guestAddress: "123 Main",
        qrData: "",
        createdAt: "2026-06-23T12:00:00.000Z",
        expiresAt: "2026-06-24T12:00:00.000Z",
        status: "active",
        used: false,
        usedAt: undefined,
      },
    ]
  );
});

test("normalizeGuestPassesResponse returns an empty list when passes are missing", () => {
  assert.deepEqual(normalizeGuestPassesResponse({}), []);
});

test("normalizeGuestPassesResponse preserves revoked pass status", () => {
  const [pass] = normalizeGuestPassesResponse({
    passes: [
      {
        id: "pass-revoked",
        guest_name: "Revoked Visitor",
        guest_email: "revoked@example.com",
        guest_phone: "555-0101",
        guest_address: null,
        status: "revoked",
        created_at: "2026-06-23T12:00:00.000Z",
        expires_at: "2026-06-24T12:00:00.000Z",
        used_at: null,
      },
    ],
  }, NOW);

  assert.equal(pass.status, "revoked");
  assert.equal(pass.used, false);
});

test("normalizeGuestPassesResponse derives expired status from expiresAt", () => {
  const basePass = {
    id: "pass-expiring",
    guest_name: "Late Visitor",
    guest_email: "late@example.com",
    guest_phone: "555-0101",
    guest_address: null,
    created_at: "2026-06-22T12:00:00.000Z",
    expires_at: "2026-06-23T12:00:00.000Z", // one hour before NOW
    used_at: null,
  };

  // A pass past its expiry must not render as active, even if the server
  // response (or client cache) still says "active".
  const [expired] = normalizeGuestPassesResponse({ passes: [basePass] }, NOW);
  assert.equal(expired.status, "expired");

  const [staleActive] = normalizeGuestPassesResponse(
    { passes: [{ ...basePass, status: "active" }] },
    NOW
  );
  assert.equal(staleActive.status, "expired");

  // Same precedence the server uses: revoked > used > expired.
  const [revoked] = normalizeGuestPassesResponse(
    { passes: [{ ...basePass, status: "revoked" }] },
    NOW
  );
  assert.equal(revoked.status, "revoked");

  const [used] = normalizeGuestPassesResponse(
    { passes: [{ ...basePass, used_at: "2026-06-23T10:00:00.000Z" }] },
    NOW
  );
  assert.equal(used.status, "used");

  // Not yet expired stays active.
  const [active] = normalizeGuestPassesResponse(
    { passes: [{ ...basePass, expires_at: "2026-06-24T12:00:00.000Z" }] },
    NOW
  );
  assert.equal(active.status, "active");
});

test("normalizeCreatedGuestPassResponse maps create response to a pass for immediate display", () => {
  assert.deepEqual(
    normalizeCreatedGuestPassResponse(
      {
        pass: {
          id: "pass-2",
          guest_name: "Sam Visitor",
          guest_email: "sam@example.com",
          guest_phone: null,
          guest_address: "Gate",
          share_url: "https://emberly.example.com/guest-pass/pass-2",
          created_at: "2026-06-23T12:00:00.000Z",
          expires_at: "2026-06-24T12:00:00.000Z",
          used_at: null,
        },
      },
      NOW
    ),
    {
      passId: "pass-2",
      guestName: "Sam Visitor",
      guestEmail: "sam@example.com",
      guestPhone: "",
      guestAddress: "Gate",
      qrData: "https://emberly.example.com/guest-pass/pass-2",
      shareUrl: "https://emberly.example.com/guest-pass/pass-2",
      createdAt: "2026-06-23T12:00:00.000Z",
      expiresAt: "2026-06-24T12:00:00.000Z",
      status: "active",
      used: false,
      usedAt: undefined,
    }
  );
});

test("normalizeCreatedGuestPassResponse uses share URL as QR data when nested pass has no QR value", () => {
  assert.deepEqual(
    normalizeCreatedGuestPassResponse(
      {
        pass: {
          id: "pass-3",
          guest_name: "No Address",
          guest_email: "noaddress@example.com",
          guest_phone: null,
          guest_address: null,
          share_url: "https://emberly.example.com/guest-pass/pass-3",
          created_at: "2026-06-23T12:00:00.000Z",
          expires_at: "2026-06-24T12:00:00.000Z",
          used_at: null,
        },
      },
      NOW
    ).qrData,
    "https://emberly.example.com/guest-pass/pass-3"
  );
});

test("resident app surfaces guest pass email delivery warnings", () => {
  const api = fs.readFileSync(path.join(process.cwd(), "lib/api.ts"), "utf8");
  const screen = fs.readFileSync(
    path.join(process.cwd(), "app/(tabs)/guest-pass.tsx"),
    "utf8"
  );

  assert.match(api, /warning\?: string/);
  assert.match(screen, /result\.warning/);
  assert.match(screen, /email could not be sent/);
  assert.match(screen, /Use Share Pass to send it manually/);
});

test("upsertGuestPass inserts a created pass at the top without duplicating it", () => {
  const existing = [
    {
      passId: "old-pass",
      guestName: "Old Visitor",
      guestEmail: "old@example.com",
      guestPhone: "",
      guestAddress: "",
    qrData: "https://emberly.example.com/guest-pass/old-pass",
    shareUrl: "https://emberly.example.com/guest-pass/old-pass",
    createdAt: "2026-06-22T12:00:00.000Z",
    expiresAt: "2026-06-23T12:00:00.000Z",
    status: "active",
    used: false,
    usedAt: undefined,
    },
  ];

  const created = {
    passId: "new-pass",
    guestName: "New Visitor",
    guestEmail: "new@example.com",
    guestPhone: "",
    guestAddress: "",
    qrData: "https://emberly.example.com/guest-pass/new-pass",
    shareUrl: "https://emberly.example.com/guest-pass/new-pass",
    createdAt: "2026-06-23T12:00:00.000Z",
    expiresAt: "2026-06-24T12:00:00.000Z",
    status: "active",
    used: false,
    usedAt: undefined,
  };

  assert.deepEqual(upsertGuestPass(existing, created), [created, existing[0]]);
  assert.deepEqual(upsertGuestPass([created, existing[0]], created), [created, existing[0]]);
});

test("buildGuestPassShareMessage shares a browser link instead of the app deep link", () => {
  const message = buildGuestPassShareMessage({
    guestName: "Sam Visitor",
    shareUrl: "https://emberly.example.com/guest-pass/pass-2",
    expiresAt: "2026-06-24T12:00:00.000Z",
  });
  // The formatted-expiry connector ("," vs " at ") and rendered hour depend on
  // the JS engine's Intl (ICU) data and timezone — V8/Node vs JSC/Bun differ —
  // so assert the stable message and the expiry's shape, not a fixed hour.
  assert.match(
    message,
    /^Sam Visitor, here is your Emberly guest pass:\n\nhttps:\/\/emberly\.example\.com\/guest-pass\/pass-2\n\nShow the QR code from this page at the entrance\. This pass expires Jun 24(,| at) \d{1,2}:\d{2} [AP]M\.$/
  );
});

test("resident app offers to resend an existing active guest pass email", () => {
  const screen = fs.readFileSync(
    path.join(process.cwd(), "app/(tabs)/guest-pass.tsx"),
    "utf8"
  );
  const apiSource = fs.readFileSync(path.join(process.cwd(), "lib/api.ts"), "utf8");

  assert.match(apiSource, /resendGuestPassEmail/);
  assert.match(apiSource, /resident\/guest-passes\/\$\{passId\}\/resend/);
  assert.match(apiSource, /existingPassId/);
  assert.match(screen, /active_guest_pass_exists/);
  assert.match(screen, /const existingPassId = err\.existingPassId/);
  assert.match(screen, /Active pass already exists/);
  assert.match(screen, /Resend Email/);
  assert.match(screen, /resendGuestPassEmail\(token, existingPassId\)/);
});
