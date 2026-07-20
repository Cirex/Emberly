
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildGuestPassPreviewImageUrl,
  buildGuestPassPreviewMetadata,
  buildGuestPassUrl,
  getGuestPassShareStatus,
  normalizeGuestPassOrigin,
} = require("../lib/guest-pass-share");

test("buildGuestPassUrl returns a browser URL for the created guest pass share token", () => {
  assert.equal(
    buildGuestPassUrl("http://192.168.1.20:3001/api/resident/guest-pass", "share-token-1"),
    "http://192.168.1.20:3001/guest-pass/share-token-1"
  );
});

test("buildGuestPassUrl prefers NEXT_PUBLIC_APP_URL when configured in production", () => {
  const original = process.env.NEXT_PUBLIC_APP_URL;
  const originalNodeEnv = process.env.NODE_ENV;

  try {
    process.env.NEXT_PUBLIC_APP_URL = "https://emberly.example.com/";
    process.env.NODE_ENV = "production";
    assert.equal(
      buildGuestPassUrl("http://localhost:3001/api/resident/guest-pass", "pass/with space"),
      "https://emberly.example.com/guest-pass/pass%2Fwith%20space"
    );
  } finally {
    if (original === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = original;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  }
});

test("buildGuestPassUrl uses the local API origin in development even when NEXT_PUBLIC_APP_URL is configured", () => {
  const originalUrl = process.env.NEXT_PUBLIC_APP_URL;
  const originalNodeEnv = process.env.NODE_ENV;

  try {
    process.env.NEXT_PUBLIC_APP_URL = "https://emberly-apartments.vercel.app";
    process.env.NODE_ENV = "development";
    assert.equal(
      buildGuestPassUrl("http://192.168.0.178:3001/api/resident/guest-pass", "share-token-1"),
      "http://192.168.0.178:3001/guest-pass/share-token-1"
    );
  } finally {
    if (originalUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = originalUrl;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  }
});

test("buildGuestPassUrl uses the configured LAN origin for localhost development requests", () => {
  const originalDevUrl = process.env.LOCAL_LAN_APP_URL;
  const originalNodeEnv = process.env.NODE_ENV;

  try {
    process.env.LOCAL_LAN_APP_URL = "http://192.168.0.22:3001";
    process.env.NODE_ENV = "development";
    assert.equal(
      buildGuestPassUrl("http://localhost:3001/api/resident/guest-pass", "share-token-1"),
      "http://192.168.0.22:3001/guest-pass/share-token-1"
    );
  } finally {
    if (originalDevUrl === undefined) {
      delete process.env.LOCAL_LAN_APP_URL;
    } else {
      process.env.LOCAL_LAN_APP_URL = originalDevUrl;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  }
});

test("buildGuestPassUrl falls back to the production app domain (PRODUCTION_ORIGIN)", () => {
  const originalUrl = process.env.NEXT_PUBLIC_APP_URL;
  const originalNodeEnv = process.env.NODE_ENV;

  try {
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.NODE_ENV = "production";
    assert.equal(
      buildGuestPassUrl("https://emberly.krkn.app/api/resident/guest-pass", "share-token-1"),
      "https://emberly.krkn.app/guest-pass/share-token-1"
    );
  } finally {
    if (originalUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = originalUrl;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  }
});

test("buildGuestPassUrl uses the active Vercel preview URL when no production app URL is configured", () => {
  const originalUrl = process.env.NEXT_PUBLIC_APP_URL;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalVercelUrl = process.env.VERCEL_URL;

  try {
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.NODE_ENV = "production";
    process.env.VERCEL_URL = "emberly-web-git-preview-benjamin.vercel.app";
    assert.equal(
      buildGuestPassUrl("http://localhost:3001/api/resident/guest-pass", "share-token-1"),
      "https://emberly-web-git-preview-benjamin.vercel.app/guest-pass/share-token-1"
    );
  } finally {
    if (originalUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = originalUrl;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalVercelUrl === undefined) {
      delete process.env.VERCEL_URL;
    } else {
      process.env.VERCEL_URL = originalVercelUrl;
    }
  }
});

test("guest pass preview helpers build stable rich link metadata", () => {
  assert.equal(normalizeGuestPassOrigin("https://emberly.example.com///"), "https://emberly.example.com");
  assert.equal(
    buildGuestPassPreviewImageUrl("https://emberly.example.com/", "pass/with space"),
    "https://emberly.example.com/guest-pass/pass%2Fwith%20space/preview-image"
  );

  const readyMeta = buildGuestPassPreviewMetadata({
    guestName: "Emily Bloch",
    expiresAt: "2026-07-02T05:48:00.000Z",
    status: { label: "Ready to scan", canRenderQr: true },
    unitId: "3644 DU-1",
  });
  assert.equal(readyMeta.title, "Emily Bloch Guest Pass");
  // The formatted-expiry connector ("," vs " at ") and rendered hour depend on
  // the JS engine's Intl (ICU) data and timezone — V8/Node vs JSC/Bun differ —
  // so assert the recipe's shape, not a fixed connector/hour.
  assert.match(
    readyMeta.description,
    /^Emberly guest access for 3644 DU-1\. Expires Jul 2(,| at) \d{1,2}:\d{2} [AP]M\.$/
  );

  assert.deepEqual(
    buildGuestPassPreviewMetadata({
      guestName: "Emily Bloch",
      expiresAt: "2026-07-02T05:48:00.000Z",
      status: { label: "Unavailable", canRenderQr: false },
    }),
    {
      title: "Emily Bloch Guest Pass",
      description: "This Emberly guest pass is unavailable.",
    }
  );
});

test("guest pass preview image route uses the classic ticket layout without QR content", () => {
  const routeSource = fs.readFileSync(
    path.join(__dirname, "../app/guest-pass/[id]/preview-image/route.tsx"),
    "utf8"
  );

  assert.match(routeSource, /Tap to view QR code/);
  assert.match(routeSource, /Single-use access/);
  assert.doesNotMatch(routeSource, /QRCode|qrcode|qrData|svg+xml/);
});

test("guest pass web page centers the rendered QR image", () => {
  const pageSource = fs.readFileSync(
    path.join(__dirname, "../app/guest-pass/[id]/page.tsx"),
    "utf8"
  );
  const qrStyle = pageSource.match(/qr:\s*\{[\s\S]*?\n  \},/)?.[0] ?? "";

  assert.match(qrStyle, /display:\s*"block"/);
  assert.match(qrStyle, /margin:\s*"0 auto"/);
});

test("guest pass web page overlays the Emberly flower in the QR center", () => {
  const pageSource = fs.readFileSync(
    path.join(__dirname, "../app/guest-pass/[id]/page.tsx"),
    "utf8"
  );

  assert.match(pageSource, /errorCorrectionLevel:\s*"H"/);
  assert.match(pageSource, /qrFrame/);
  assert.match(pageSource, /qrLogoShell/);
  assert.match(pageSource, /\/logo-flower-transparent\.png/);
});

test("guest pass share status only allows a QR for active passes", () => {
  const now = Date.parse("2026-06-23T12:00:00.000Z");

  assert.deepEqual(
    getGuestPassShareStatus({ status: "active", usedAt: null, expiresAt: "2026-06-23T12:30:00.000Z" }, now),
    { label: "Ready to scan", canRenderQr: true }
  );
  assert.deepEqual(
    getGuestPassShareStatus({ status: "revoked", usedAt: null, expiresAt: "2026-06-23T12:30:00.000Z" }, now),
    { label: "Unavailable", canRenderQr: false }
  );
  assert.deepEqual(
    getGuestPassShareStatus({ status: "active", usedAt: "2026-06-23T12:01:00.000Z", expiresAt: "2026-06-23T12:30:00.000Z" }, now),
    { label: "Already used", canRenderQr: false }
  );
  assert.deepEqual(
    getGuestPassShareStatus({ status: "active", usedAt: null, expiresAt: "2026-06-23T11:59:00.000Z" }, now),
    { label: "Expired", canRenderQr: false }
  );
});
