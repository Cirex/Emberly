const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DeletePushTokenSchema,
  RegisterPushTokenSchema,
  buildPushTokenUpsert,
  deactivatePushToken,
  registerPushToken,
} = require("../lib/push-tokens");

const admin = { adminId: "admin-1", role: "property_manager", displayName: "Jane Staff" };

test("RegisterPushTokenSchema accepts a token with optional platform", () => {
  const parsed = RegisterPushTokenSchema.safeParse({ token: "ExponentPushToken[abc123]" });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.platform, undefined);

  const android = RegisterPushTokenSchema.safeParse({
    token: "ExponentPushToken[abc123]",
    platform: "android",
  });
  assert.equal(android.success, true);
  assert.equal(android.data.platform, "android");
});

test("RegisterPushTokenSchema rejects missing, empty, oversized, and bad-platform bodies", () => {
  assert.equal(RegisterPushTokenSchema.safeParse({}).success, false);
  assert.equal(RegisterPushTokenSchema.safeParse({ token: "" }).success, false);
  assert.equal(RegisterPushTokenSchema.safeParse({ token: "x".repeat(513) }).success, false);
  assert.equal(RegisterPushTokenSchema.safeParse({ token: "x".repeat(512) }).success, true);
  assert.equal(
    RegisterPushTokenSchema.safeParse({ token: "ExponentPushToken[a]", platform: "web" }).success,
    false,
  );
  assert.equal(RegisterPushTokenSchema.safeParse({ token: 42 }).success, false);
});

test("DeletePushTokenSchema requires a non-empty token", () => {
  assert.equal(DeletePushTokenSchema.safeParse({ token: "ExponentPushToken[a]" }).success, true);
  assert.equal(DeletePushTokenSchema.safeParse({ token: "" }).success, false);
  assert.equal(DeletePushTokenSchema.safeParse({}).success, false);
});

test("buildPushTokenUpsert attributes the row to the authenticated staff subject", () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const row = buildPushTokenUpsert(admin, { token: "ExponentPushToken[abc]" }, now);
  assert.deepEqual(row, {
    expo_push_token: "ExponentPushToken[abc]",
    admin_id: "admin-1",
    display_name: "Jane Staff",
    platform: "ios",
    app: "maintenance",
    alert_kinds: [],
    active: true,
    last_seen_at: "2026-07-21T12:00:00.000Z",
    updated_at: "2026-07-21T12:00:00.000Z",
  });

  const android = buildPushTokenUpsert(
    admin,
    { token: "ExponentPushToken[abc]", platform: "android" },
    now,
  );
  assert.equal(android.platform, "android");
});

test("buildPushTokenUpsert scopes the row to the registering app", () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  // The maintenance app predates the field and still omits it; its rows must
  // keep landing in the maintenance fleet.
  assert.equal(buildPushTokenUpsert(admin, { token: "t" }, now).app, "maintenance");
  assert.equal(buildPushTokenUpsert(admin, { token: "t", app: "manager" }, now).app, "manager");
});

test("buildPushTokenUpsert stores alert kinds deduped and sorted", () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const row = buildPushTokenUpsert(
    admin,
    {
      token: "t",
      app: "manager",
      alertKinds: ["utility_spike", "lease_signed", "utility_spike"],
    },
    now,
  );
  assert.deepEqual(row.alert_kinds, ["lease_signed", "utility_spike"]);
  // Omitted = no recorded preference = every kind, server-side.
  assert.deepEqual(buildPushTokenUpsert(admin, { token: "t" }, now).alert_kinds, []);
});

test("RegisterPushTokenSchema validates the app and alertKinds fields", () => {
  const ok = RegisterPushTokenSchema.safeParse({
    token: "ExponentPushToken[a]",
    app: "manager",
    alertKinds: ["lease_signed"],
  });
  assert.equal(ok.success, true);
  assert.equal(ok.data.app, "manager");
  assert.equal(
    RegisterPushTokenSchema.safeParse({ token: "ExponentPushToken[a]", app: "resident" }).success,
    false,
  );
  assert.equal(
    RegisterPushTokenSchema.safeParse({ token: "ExponentPushToken[a]", alertKinds: [""] }).success,
    false,
  );
  assert.equal(
    RegisterPushTokenSchema.safeParse({ token: "ExponentPushToken[a]", alertKinds: "all" }).success,
    false,
  );
});

test("registerPushToken upserts by expo_push_token", async () => {
  const calls = [];
  const client = {
    from(table) {
      return {
        upsert(row, options) {
          calls.push({ table, row, options });
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  await registerPushToken(client, admin, { token: "ExponentPushToken[abc]" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, "push_tokens");
  assert.deepEqual(calls[0].options, { onConflict: "expo_push_token" });
  assert.equal(calls[0].row.active, true);
});

test("deactivatePushToken is an idempotent no-op for unknown tokens", async () => {
  const calls = [];
  const client = {
    from(table) {
      return {
        update(patch) {
          return {
            eq(column, value) {
              calls.push({ table, patch, column, value });
              // Supabase reports no error for an update matching zero rows,
              // so an unknown token resolves cleanly (idempotent 200 path).
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };

  await deactivatePushToken(client, "ExponentPushToken[gone]");
  await deactivatePushToken(client, "ExponentPushToken[gone]");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.table, "push_tokens");
    assert.equal(call.column, "expo_push_token");
    assert.equal(call.value, "ExponentPushToken[gone]");
    assert.equal(call.patch.active, false);
  }
});

test("push-tokens route registers on POST and deactivates on DELETE", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const route = fs.readFileSync(
    path.join(process.cwd(), "app/api/admin/push-tokens/route.ts"),
    "utf8",
  );
  assert.match(route, /requireAdminOrScanner/);
  assert.match(route, /RegisterPushTokenSchema/);
  assert.match(route, /DeletePushTokenSchema/);
  assert.match(route, /registerPushToken/);
  assert.match(route, /deactivatePushToken/);
  assert.match(route, /export async function POST/);
  assert.match(route, /export async function DELETE/);
});
