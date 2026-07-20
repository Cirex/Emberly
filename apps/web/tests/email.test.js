delete process.env.RESEND_API_KEY;


const assert = require("node:assert/strict");
const test = require("node:test");

test("email module can be imported without a Resend API key at build time", () => {
  const email = require("../lib/email");
  assert.equal(typeof email.sendGuestPassEmail, "function");
});

test("guest pass email payload uses Emberly branding and notifications sender", () => {
  const { buildGuestPassEmailPayload } = require("../lib/email");

  const payload = buildGuestPassEmailPayload({
    guestName: "Michael <Carter>",
    guestEmail: "michael@example.com",
    residentName: "Emily Bloch",
    unitAddress: "3644 DU-1",
    propertyName: "Emberly Apartments",
    shareUrl: "https://notifications.emberlyapartments.com/guest-pass/share-token-1",
    expiresAt: new Date("2026-07-02T04:59:00.000Z"),
    passId: "pass-123456789",
  });

  assert.equal(payload.from, "Emberly Guest Passes <guest-passes@notifications.emberlyapartments.com>");
  assert.equal(payload.to, "michael@example.com");
  assert.match(payload.subject, /Your Emberly guest pass/);
  assert.match(payload.html, /EMBERLY/);
  assert.match(payload.html, /APARTMENTS/);
  assert.match(payload.html, /logo-flower-transparent\.png/);
  assert.match(payload.html, /src="https:\/\/notifications\.emberlyapartments\.com\/logo-flower-transparent\.png"/);
  assert.doesNotMatch(payload.html, /emberly-web\.vercel\.app/);
  assert.match(payload.html, /View Guest Pass/);
  assert.match(payload.html, /https:\/\/notifications\.emberlyapartments\.com\/guest-pass\/share-token-1/);
  assert.match(payload.html, /Michael &lt;Carter&gt;/);
  assert.match(payload.text, /View your guest pass:/);
  assert.match(payload.text, /https:\/\/notifications\.emberlyapartments\.com\/guest-pass\/share-token-1/);
});

test("guest pass email payload keeps action and asset URLs on the sending domain", () => {
  const { buildGuestPassEmailPayload } = require("../lib/email");

  const payload = buildGuestPassEmailPayload({
    guestName: "Michael Carter",
    guestEmail: "michael@example.com",
    residentName: "Emily Bloch",
    unitAddress: "3644 DU-1",
    propertyName: "Emberly Apartments",
    shareUrl: "https://emberly-apartments.vercel.app/guest-pass/share-token-1",
    expiresAt: new Date("2026-07-02T04:59:00.000Z"),
    passId: "pass-123456789",
  });
  const urls = [...payload.html.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)].map(
    (match) => new URL(match[1])
  );

  assert.ok(urls.length >= 2);
  assert.ok(urls.every((url) => url.hostname === "notifications.emberlyapartments.com"));
  assert.match(payload.text, /https:\/\/notifications\.emberlyapartments\.com\/guest-pass\/share-token-1/);
  assert.doesNotMatch(payload.text, /emberly-web\.vercel\.app/);
});

test("guest pass email payload does not embed a base64 QR image", () => {
  const { buildGuestPassEmailPayload } = require("../lib/email");

  const payload = buildGuestPassEmailPayload({
    guestName: "Michael Carter",
    guestEmail: "michael@example.com",
    residentName: "Emily Bloch",
    unitAddress: "3644 DU-1",
    propertyName: "Emberly Apartments",
    shareUrl: "https://notifications.emberlyapartments.com/guest-pass/share-token-1",
    expiresAt: new Date("2026-07-02T04:59:00.000Z"),
    passId: "pass-123456789",
  });

  assert.doesNotMatch(payload.html, /data:image/);
  assert.doesNotMatch(payload.text, /data:image/);
});

test("guest pass email image URLs are hosted on the sender domain", () => {
  const { buildGuestPassEmailPayload } = require("../lib/email");

  const payload = buildGuestPassEmailPayload({
    guestName: "Michael Carter",
    guestEmail: "michael@example.com",
    residentName: "Emily Bloch",
    unitAddress: "3644 DU-1",
    propertyName: "Emberly Apartments",
    shareUrl: "https://emberly-apartments.vercel.app/guest-pass/share-token-1",
    expiresAt: new Date("2026-07-02T04:59:00.000Z"),
    passId: "pass-123456789",
  });
  const imageSources = [...payload.html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]);

  assert.ok(imageSources.length > 0);
  assert.ok(imageSources.every((src) => !src.startsWith("data:image")));
  assert.ok(imageSources.every((src) => new URL(src).hostname === "notifications.emberlyapartments.com"));
});
