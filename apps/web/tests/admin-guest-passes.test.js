
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { formatUnitForColumn, getGuestPassStatus } = require("../lib/admin-data");
const { normalizeAdminGuestPassSearch } = require("../lib/admin-search");

test("getGuestPassStatus prioritizes revoked and used states", () => {
  const now = new Date("2026-06-23T12:00:00.000Z");

  assert.equal(
    getGuestPassStatus({ status: "revoked", used_at: null, expires_at: "2026-06-24T12:00:00.000Z" }, now),
    "revoked"
  );
  assert.equal(
    getGuestPassStatus({ status: "active", used_at: "2026-06-23T11:00:00.000Z", expires_at: "2026-06-24T12:00:00.000Z" }, now),
    "used"
  );
});

test("getGuestPassStatus separates active and expired passes", () => {
  const now = new Date("2026-06-23T12:00:00.000Z");

  assert.equal(
    getGuestPassStatus({ status: "active", used_at: null, expires_at: "2026-06-24T12:00:00.000Z" }, now),
    "active"
  );
  assert.equal(
    getGuestPassStatus({ status: "active", used_at: null, expires_at: "2026-06-22T12:00:00.000Z" }, now),
    "expired"
  );
});

test("normalizeAdminGuestPassSearch rejects PostgREST filter syntax characters", () => {
  assert.equal(normalizeAdminGuestPassSearch("Jane Visitor"), "Jane Visitor");
  assert.equal(normalizeAdminGuestPassSearch("jane@example.com"), "jane@example.com");
  assert.equal(normalizeAdminGuestPassSearch("Jane,guest_email.ilike.%"), null);
  assert.equal(normalizeAdminGuestPassSearch("Jane(or.true)"), null);
  assert.equal(normalizeAdminGuestPassSearch("Jane%"), null);
});

test("formatUnitForColumn removes a leading Unit label for table cells", () => {
  assert.equal(formatUnitForColumn("Unit 3644 DU-1"), "3644 DU-1");
  assert.equal(formatUnitForColumn("unit 1726 ST-4"), "1726 ST-4");
  assert.equal(formatUnitForColumn("3644 DU-1"), "3644 DU-1");
});

test("formatUnitForColumn falls back for missing unit values", () => {
  assert.equal(formatUnitForColumn(null), "—");
  assert.equal(formatUnitForColumn(undefined), "—");
  assert.equal(formatUnitForColumn("   "), "—");
});

test("admin guest passes table shows unit without a separate resident column", () => {
  const client = fs.readFileSync(
    path.join(process.cwd(), "app/admin/(protected)/guest-passes/guest-passes-client.tsx"),
    "utf8"
  );

  assert.equal(client.includes("<th>Resident</th>"), false);
  assert.equal(client.includes("<th>Unit</th>"), true);
});

test("admin guest passes can filter, extend, and revoke active passes", () => {
  const client = fs.readFileSync(
    path.join(process.cwd(), "app/admin/(protected)/guest-passes/guest-passes-client.tsx"),
    "utf8"
  );
  const route = fs.readFileSync(
    path.join(process.cwd(), "app/api/admin/guest-passes/[id]/route.ts"),
    "utf8"
  );

  assert.equal(client.includes('value="revoked"'), true);
  assert.equal(client.includes('value="banned"'), false);
  assert.equal(client.includes("banned:"), false);
  assert.match(client, /Revoke/);
  assert.match(client, /status:\s*"revoked"/);
  assert.match(route, /status:\s*z\.enum\(\["revoked"\]\)\.optional\(\)/);
  assert.match(route, /update\.status = "revoked"/);
});

test("admin guest passes include derived share URLs without returning share tokens", () => {
  const list = fs.readFileSync(
    path.join(process.cwd(), "lib/admin-guest-passes.ts"),
    "utf8"
  );
  const route = fs.readFileSync(
    path.join(process.cwd(), "app/api/admin/guest-passes/route.ts"),
    "utf8"
  );

  assert.match(list, /share_token/);
  assert.match(list, /share_url:\s*buildGuestPassUrl\(requestUrl,\s*share_token\)/);
  assert.match(list, /\(\{ share_token, \.\.\.pass \}\)/);
  assert.match(route, /requestUrl:\s*request\.url/);
});

test("resident guest pass creation requires guest phone number", () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), "app/api/resident/guest-pass/route.ts"),
    "utf8"
  );

  assert.match(route, /phone:\s*z\.string\(\)\.trim\(\)\.min\(1,\s*"Guest phone is required"\)/);
  assert.equal(route.includes("phone: z.string().optional()"), false);
});

test("admin guest pass expiry changes only apply to active passes", () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), "app/api/admin/guest-passes/[id]/route.ts"),
    "utf8"
  );

  assert.match(route, /existing\.status !== "active"/);
  assert.match(route, /Cannot change the expiry of a/);
  assert.match(route, /status: 409/);
  assert.match(route, /updateQuery = updateQuery\.eq\("status", "active"\)/);
});

test("resident guest pass creation sweeps concurrent duplicates after insert", () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), "app/api/resident/guest-pass/route.ts"),
    "utf8"
  );

  assert.match(route, /duplicatePasses/);
  assert.match(route, /\.order\("created_at", \{ ascending: true \}\)/);
  assert.match(route, /survivor\.id !== guestPass\.id/);
  assert.match(route, /update\(\{ status: "revoked" \}\)[\s\S]*?\.eq\("id", guestPass\.id\)/);
  assert.ok(
    route.indexOf("Duplicate sweep error") < route.indexOf("sendAndRecordGuestPassEmail({"),
    "duplicate sweep must run before the guest email is sent"
  );
});

test("resident guest pass creation blocks duplicate active guest emails before insert", () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), "app/api/resident/guest-pass/route.ts"),
    "utf8"
  );

  assert.match(route, /active_guest_pass_exists/);
  assert.match(route, /normalizedGuestEmail/);
  assert.match(route, /\.eq\("guest_email", normalizedGuestEmail\)/);
  assert.match(route, /\.eq\("status", "active"\)/);
  assert.match(route, /\.is\("used_at", null\)/);
  assert.match(route, /\.gte\("expires_at", nowIso\)/);
});

test("resident guest pass resend endpoint only resends owned active passes", () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), "app/api/resident/guest-passes/[id]/resend/route.ts"),
    "utf8"
  );

  const emailLib = fs.readFileSync(
    path.join(process.cwd(), "lib/guest-pass-email.ts"),
    "utf8"
  );

  assert.match(route, /sendAndRecordGuestPassEmail/);
  assert.match(emailLib, /email_delivery_status: "sent"/);
  assert.match(emailLib, /email_provider_id: email\.emailId/);
  assert.match(emailLib, /email_delivery_status: "failed"/);
  assert.match(route, /\.eq\("resident_id", payload\.residentId\)/);
  assert.match(route, /\.eq\("status", "active"\)/);
  assert.match(route, /\.is\("used_at", null\)/);
  assert.match(route, /\.gte\("expires_at", nowIso\)/);
  assert.match(route, /checkRateLimit/);
  assert.match(route, /guest-pass-resend:\$\{payload\.residentId\}:\$\{id\}/);
  assert.match(route, /resent: true/);
});

test("resident guest pass revoke endpoint only revokes owned active passes", () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), "app/api/resident/guest-passes/[id]/revoke/route.ts"),
    "utf8"
  );

  assert.match(route, /\.eq\("resident_id", payload\.residentId\)/);
  assert.match(route, /\.eq\("status", "active"\)/);
  assert.match(route, /\.is\("used_at", null\)/);
  assert.match(route, /\.gte\("expires_at", nowIso\)/);
  assert.match(route, /status: "revoked"/);
  assert.match(route, /revoked: true/);
});
