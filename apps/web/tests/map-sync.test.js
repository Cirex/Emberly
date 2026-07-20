
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { mock } = require("bun:test");

const {
  MAP_ANNOTATIONS_FEATURE_KEY,
  buildSyncCapabilities,
  createClaimToken,
  createSyncKeySecret,
  hashRequesterLogin,
  hashSecret,
  isCapabilityAllowed,
  verifySecretHash,
} = require("../lib/map-sync");
const {
  buildAccessRequestInsert,
  buildAccessAuditInsert,
  buildApprovedRequestPatch,
  buildClaimedRequestPatch,
  buildRejectedRequestPatch,
  buildRevokedKeyPatch,
  buildSyncKeyInsert,
  canAdminManageMapSync,
  canViewMapSyncAdmin,
} = require("../lib/map-sync-access");

test("map sync constants use the annotations feature key", () => {
  assert.equal(MAP_ANNOTATIONS_FEATURE_KEY, "property_map.annotations");
});

test("hashSecret verifies exact secrets without storing raw values", () => {
  const hash = hashSecret("secret-value");
  assert.match(hash, /^sha256:/);
  assert.notEqual(hash.includes("secret-value"), true);
  assert.equal(verifySecretHash("secret-value", hash), true);
  assert.equal(verifySecretHash("other-value", hash), false);
});

test("verifySecretHash rejects missing and malformed hashes", () => {
  assert.equal(verifySecretHash("secret-value", null), false);
  assert.equal(verifySecretHash("secret-value", undefined), false);
  assert.equal(verifySecretHash("secret-value", "secret-value"), false);
  assert.equal(verifySecretHash("secret-value", "sha256:not-a-valid-length"), false);
});

test("createSyncKeySecret and createClaimToken return high entropy URL-safe secrets", () => {
  const syncKey = createSyncKeySecret();
  const claimToken = createClaimToken();
  assert.match(syncKey, /^emsync_[A-Za-z0-9_-]{43}$/);
  assert.match(claimToken, /^emclaim_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(syncKey, createSyncKeySecret());
  assert.notEqual(claimToken, createClaimToken());
});

test("hashRequesterLogin normalizes logins before hashing with a server pepper", () => {
  const original = process.env.MAP_SYNC_HASH_SECRET;
  process.env.MAP_SYNC_HASH_SECRET = "map-sync-hash-secret-for-tests";

  try {
    const hash = hashRequesterLogin(" Jane@Example.COM ");
    assert.equal(hash, hashRequesterLogin("jane@example.com"));
    assert.match(hash, /^hmac-sha256:/);
    assert.notEqual(hash, hashSecret("resman-login:jane@example.com"));
    assert.equal(hashRequesterLogin(" "), null);
    assert.equal(hashRequesterLogin(null), null);
    assert.equal(hashRequesterLogin(undefined), null);
  } finally {
    if (original === undefined) {
      delete process.env.MAP_SYNC_HASH_SECRET;
    } else {
      process.env.MAP_SYNC_HASH_SECRET = original;
    }
  }
});

test("hashRequesterLogin requires a dedicated hash secret in production", () => {
  const originals = {
    NODE_ENV: process.env.NODE_ENV,
    MAP_SYNC_HASH_SECRET: process.env.MAP_SYNC_HASH_SECRET,
    ADMIN_SESSION_SECRET: process.env.ADMIN_SESSION_SECRET,
    API_SECRET_KEY: process.env.API_SECRET_KEY,
  };

  process.env.NODE_ENV = "production";
  delete process.env.MAP_SYNC_HASH_SECRET;
  process.env.ADMIN_SESSION_SECRET = "admin-session-secret-for-tests";
  process.env.API_SECRET_KEY = "api-secret-for-tests";

  try {
    assert.throws(() => hashRequesterLogin("jane@example.com"), /MAP_SYNC_HASH_SECRET/);
  } finally {
    restoreEnv(originals);
  }
});

test("hashRequesterLogin uses scoped non-production fallback secrets", () => {
  const originals = {
    NODE_ENV: process.env.NODE_ENV,
    MAP_SYNC_HASH_SECRET: process.env.MAP_SYNC_HASH_SECRET,
    ADMIN_SESSION_SECRET: process.env.ADMIN_SESSION_SECRET,
    API_SECRET_KEY: process.env.API_SECRET_KEY,
  };

  process.env.NODE_ENV = "test";
  delete process.env.MAP_SYNC_HASH_SECRET;
  process.env.ADMIN_SESSION_SECRET = "admin-session-secret-a";
  process.env.API_SECRET_KEY = "api-secret-for-tests";
  const adminSecretHash = hashRequesterLogin("jane@example.com");

  process.env.ADMIN_SESSION_SECRET = "admin-session-secret-b";
  const changedAdminSecretHash = hashRequesterLogin("jane@example.com");

  delete process.env.ADMIN_SESSION_SECRET;
  const apiSecretHash = hashRequesterLogin("jane@example.com");

  try {
    assert.match(adminSecretHash, /^hmac-sha256:/);
    assert.notEqual(adminSecretHash, changedAdminSecretHash);
    assert.notEqual(changedAdminSecretHash, apiSecretHash);
  } finally {
    restoreEnv(originals);
  }
});

test("buildSyncCapabilities defaults annotation keys to read and mutation access", () => {
  const caps = buildSyncCapabilities();
  assert.deepEqual(caps, { read: true, create: true, update: true, delete: true });
  assert.equal(isCapabilityAllowed(caps, "read"), true);
  assert.equal(isCapabilityAllowed(caps, "delete"), true);
  assert.equal(isCapabilityAllowed({ read: true }, "delete"), false);
  assert.deepEqual(buildSyncCapabilities({ delete: false }), {
    read: true,
    create: true,
    update: true,
    delete: false,
  });
  assert.equal(isCapabilityAllowed(null, "read"), false);
  assert.equal(isCapabilityAllowed(undefined, "read"), false);
});

test("schema keeps scoped map access, keys, annotations, photos, and audit tables", () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), "lib/supabase/schema.sql"),
    "utf8"
  );

  for (const tableName of [
    "map_sync_access_requests",
    "map_sync_keys",
    "map_annotations",
    "map_annotation_photos",
    "map_annotation_audit_logs",
  ]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${tableName}`));
    assert.match(sql, new RegExp(`alter table public\\.${tableName} enable row level security`));
  }

  for (const indexName of [
    "map_sync_access_requests_scope_idx",
    "map_sync_access_requests_status_idx",
    "map_sync_access_requests_active_unique_idx",
    "map_sync_keys_scope_idx",
    "map_sync_keys_scope_reference_idx",
    "map_sync_keys_device_idx",
    "map_annotations_scope_reference_idx",
    "map_annotations_property_updated_idx",
    "map_annotations_deleted_idx",
    "map_annotation_photos_annotation_idx",
    "map_annotation_audit_logs_property_idx",
    "map_annotation_audit_logs_annotation_idx",
  ]) {
    assert.match(sql, new RegExp(indexName));
  }

  for (const constraintName of [
    "map_annotations_created_key_scope_fkey",
    "map_annotations_updated_key_scope_fkey",
    "map_annotations_deleted_key_scope_fkey",
    "map_annotation_photos_annotation_scope_fkey",
    "map_annotation_photos_created_key_scope_fkey",
    "map_annotation_audit_logs_annotation_scope_fkey",
    "map_annotation_audit_logs_sync_key_scope_fkey",
  ]) {
    assert.match(sql, new RegExp(constraintName));
  }

  assert.match(sql, /'access\.claim'/);
  assert.match(sql, /version integer not null default 1 check \(version > 0\)/);
  assert.match(sql, /status text not null check \(status in \('pending', 'approved', 'rejected', 'claimed', 'revoked'\)\)/);
  assert.match(sql, /rejection_reason text/);
});


function restoreEnv(originals) {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

test("buildAccessRequestInsert hashes claim token and requester login", () => {
  const row = buildAccessRequestInsert({
    resmanAccountId: "1659",
    propertyId: "property-1",
    propertyName: "Emberly Apartments",
    featureKey: "property_map.annotations",
    requesterDisplayName: "Jane Staff",
    requesterResmanLogin: "Jane@Example.com",
    deviceId: "device-1",
    claimToken: "claim-secret",
  });

  assert.equal(row.resman_account_id, "1659");
  assert.equal(row.property_id, "property-1");
  assert.equal(row.status, "pending");
  assert.equal(row.claim_token_hash.includes("claim-secret"), false);
  assert.equal(row.requester_resman_login_hash, hashRequesterLogin("jane@example.com"));
});

test("map sync admin management excludes viewers", () => {
  assert.equal(canAdminManageMapSync({ role: "viewer" }), false);
  assert.equal(canAdminManageMapSync({ role: "property_manager" }), true);
  assert.equal(canAdminManageMapSync({ role: "security_manager" }), true);
  assert.equal(canAdminManageMapSync({ role: "super_admin" }), true);
  assert.equal(canViewMapSyncAdmin(null), false);
  assert.equal(canViewMapSyncAdmin(undefined), false);
  assert.equal(canViewMapSyncAdmin({ role: "viewer" }), false);
  assert.equal(canViewMapSyncAdmin({ role: "property_manager" }), true);
});

test("sync key insert builder hashes secret and access approval audit records admin", () => {
  const request = {
    id: "request-1",
    resman_account_id: "1659",
    property_id: "property-1",
    property_name: "Emberly",
    feature_key: "property_map.annotations",
    requester_display_name: "Jane Staff",
    requester_resman_login_hash: "hmac-sha256:abc",
    device_id: "device-1",
  };
  const admin = { adminId: "admin-1", role: "property_manager", displayName: "Manager" };
  const patch = buildApprovedRequestPatch(admin, "2026-06-29T12:00:00.000Z");
  const keyInsert = buildSyncKeyInsert(request, "sync-secret");
  const audit = buildAccessAuditInsert("access.approve", request, admin, { syncKeyId: "key-1" });

  assert.equal(patch.status, "approved");
  assert.equal(patch.approved_by, "admin-1");
  assert.equal(keyInsert.key_hash.includes("sync-secret"), false);
  assert.equal(keyInsert.property_id, "property-1");
  assert.equal(audit.action, "access.approve");
  assert.equal(audit.admin_user_id, "admin-1");
});

test("claim patch marks approved request as claimed and audited", () => {
  const request = {
    id: "request-1",
    resman_account_id: "1659",
    property_id: "property-1",
    property_name: "Emberly",
    feature_key: "property_map.annotations",
    requester_display_name: "Jane Staff",
    requester_resman_login_hash: "hmac-sha256:abc",
    device_id: "device-1",
  };

  assert.deepEqual(buildClaimedRequestPatch("2026-06-29T12:00:00.000Z"), {
    status: "claimed",
    updated_at: "2026-06-29T12:00:00.000Z",
  });
  assert.equal(buildAccessAuditInsert("access.claim", request, null).action, "access.claim");
});

test("reject and revoke builders preserve admin actor, reason, and audit action", () => {
  const request = {
    id: "request-1",
    resman_account_id: "1659",
    property_id: "property-1",
    property_name: "Emberly",
    feature_key: "property_map.annotations",
    requester_display_name: "Jane Staff",
    requester_resman_login_hash: "hmac-sha256:abc",
    device_id: "device-1",
  };
  const admin = { adminId: "admin-1", role: "security_manager", displayName: "Security" };
  const rejected = buildRejectedRequestPatch(admin, "2026-06-29T12:15:00.000Z", " Duplicate request ");
  const revoked = buildRevokedKeyPatch(admin, "2026-06-29T12:20:00.000Z");

  assert.deepEqual(rejected, {
    status: "rejected",
    rejected_by: "admin-1",
    rejected_at: "2026-06-29T12:15:00.000Z",
    rejection_reason: "Duplicate request",
    updated_at: "2026-06-29T12:15:00.000Z",
  });
  assert.deepEqual(revoked, {
    active: false,
    revoked_by: "admin-1",
    revoked_at: "2026-06-29T12:20:00.000Z",
  });
  assert.equal(buildAccessAuditInsert("access.reject", request, admin).action, "access.reject");
  assert.equal(
    buildAccessAuditInsert("access.revoke", request, admin, { syncKeyId: "key-1" }).sync_key_id,
    "key-1"
  );
});

test("map access routes handle malformed JSON before broad error handling", () => {
  for (const routePath of [
    "app/api/map/access-requests/route.ts",
    "app/api/map/access-requests/[requestId]/claim/route.ts",
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), routePath), "utf8");
    assert.match(source, /readJson\(request\)/);
    assert.match(source, /from "@\/lib\/http"/);
    assert.match(source, /return NextResponse\.json\(\{ error: "Invalid request" \}, \{ status: 400 \}\)/);
    assert.doesNotMatch(source, /safeParse\(await request\.json\(\)\)/);
  }
});

test("map access request route returns claim token when audit insert fails", async () => {
  const insertedRows = [];
  const route = loadRouteWithMocks("app/api/map/access-requests/route.ts", {
    "@/lib/rate-limit": {
      checkRateLimit: async () => true,
    },
    "@/lib/supabase/admin": {
      createUntypedAdminClient: () => ({
        from(table) {
          if (table === "map_sync_keys") {
            return {
              select() {
                return chainResult({ data: null, error: null });
              },
            };
          }
          if (table === "map_sync_access_requests") {
            return {
              insert(row) {
                insertedRows.push(row);
                return chainResult({
                  data: {
                    id: "request-1",
                    resman_account_id: row.resman_account_id,
                    property_id: row.property_id,
                    property_name: row.property_name,
                    feature_key: row.feature_key,
                    requester_display_name: row.requester_display_name,
                    requester_resman_login_hash: row.requester_resman_login_hash,
                    device_id: row.device_id,
                    status: row.status,
                  },
                  error: null,
                });
              },
            };
          }
          if (table === "map_annotation_audit_logs") {
            return {
              insert() {
                return Promise.resolve({ error: new Error("audit unavailable") });
              },
            };
          }
          throw new Error(`Unexpected table ${table}`);
        },
      }),
    },
  });

  const response = await route.POST(jsonRequest({
    resmanAccountId: "1659",
    propertyId: "property-1",
    propertyName: "Emberly Apartments",
    requesterDisplayName: "Jane Staff",
    requesterResmanLogin: "jane@example.com",
    deviceId: "device-1",
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.requestId, "request-1");
  assert.equal(body.status, "pending");
  assert.match(body.claimToken, /^emclaim_[A-Za-z0-9_-]{43}$/);
  assert.equal(insertedRows.length, 1);
  assert.match(insertedRows[0].claim_token_hash, /^sha256:/);
  assert.equal(Object.hasOwn(insertedRows[0], "claimToken"), false);
});

test("map access request route rejects malformed JSON without touching Supabase", async () => {
  let createAdminClientCalled = false;
  const route = loadRouteWithMocks("app/api/map/access-requests/route.ts", {
    "@/lib/rate-limit": {
      checkRateLimit: async () => true,
    },
    "@/lib/supabase/admin": {
      createUntypedAdminClient: () => {
        createAdminClientCalled = true;
        throw new Error("Supabase should not be created for invalid JSON");
      },
    },
  });

  const response = await route.POST({
    json: async () => {
      throw new Error("bad json");
    },
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(body, { error: "Invalid request" });
  assert.equal(createAdminClientCalled, false);
});

test("map access request route rate limits before Supabase mutation", async () => {
  let createAdminClientCalled = false;
  const rateLimitBuckets = [];
  const route = loadRouteWithMocks("app/api/map/access-requests/route.ts", {
    "@/lib/rate-limit": {
      checkRateLimit: async (input) => {
        rateLimitBuckets.push(input.bucket);
        return false;
      },
    },
    "@/lib/supabase/admin": {
      createUntypedAdminClient: () => {
        createAdminClientCalled = true;
        throw new Error("Supabase should not be created while rate limited");
      },
    },
  });

  const response = await route.POST(jsonRequest({
    resmanAccountId: "1659",
    propertyId: "property-1",
    propertyName: "Emberly Apartments",
    deviceId: "device-1",
  }, { "x-forwarded-for": "203.0.113.10" }));
  const body = await response.json();

  assert.equal(response.status, 429);
  assert.deepEqual(body, { error: "Too many map data access attempts" });
  assert.equal(createAdminClientCalled, false);
  assert.equal(rateLimitBuckets[0], "map-access-request:203.0.113.10");
});

test("map access request route blocks duplicate requests when an active sync key exists", async () => {
  const operations = [];
  const scripts = [
    { table: "map_sync_keys", select: { data: { id: "key-1" }, error: null } },
  ];
  const route = loadRouteWithMocks("app/api/map/access-requests/route.ts", {
    "@/lib/rate-limit": {
      checkRateLimit: async () => true,
    },
    "@/lib/supabase/admin": {
      createUntypedAdminClient: () => scriptedSupabase(scripts, operations),
    },
  });

  const response = await route.POST(jsonRequest({
    resmanAccountId: "1659",
    propertyId: "property-1",
    propertyName: "Emberly Apartments",
    deviceId: "device-1",
  }));
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.reason, "active_key_exists");
  assert.equal(operations.length, 1);
  assert.equal(operations[0].table, "map_sync_keys");
  assert.equal(operations[0].action, "select");
  assert.deepEqual(operations[0].filters.slice(-5), [
    ["resman_account_id", "1659"],
    ["property_id", "property-1"],
    ["feature_key", MAP_ANNOTATIONS_FEATURE_KEY],
    ["device_id", "device-1"],
    ["active", true],
  ]);
});

test("map access claim route rolls back claimed request when sync key insert fails", async () => {
  const operations = [];
  const accessRequest = {
    id: "request-1",
    resman_account_id: "1659",
    property_id: "property-1",
    property_name: "Emberly Apartments",
    feature_key: MAP_ANNOTATIONS_FEATURE_KEY,
    requester_display_name: "Jane Staff",
    requester_resman_login_hash: "hmac-sha256:abc",
    device_id: "device-1",
    status: "approved",
    claim_token_hash: hashSecret("claim-secret"),
  };
  const scripts = [
    { table: "map_sync_access_requests", select: { data: accessRequest, error: null } },
    { table: "map_sync_keys", select: { data: null, error: null } },
    { table: "map_sync_access_requests", update: { data: { id: "request-1" }, error: null } },
    { table: "map_sync_keys", insert: { data: null, error: new Error("insert failed") } },
    { table: "map_sync_access_requests", update: { data: null, error: null } },
  ];
  const route = loadRouteWithMocks("app/api/map/access-requests/[requestId]/claim/route.ts", {
    "@/lib/rate-limit": {
      checkRateLimit: async () => true,
    },
    "@/lib/supabase/admin": {
      createUntypedAdminClient: () => scriptedSupabase(scripts, operations),
    },
  });

  const response = await route.POST(
    jsonRequest({ deviceId: "device-1", claimToken: "claim-secret" }),
    { params: Promise.resolve({ requestId: "request-1" }) }
  );
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.deepEqual(body, { error: "Failed to create sync key" });

  const claimUpdate = operations.find((operation) =>
    operation.table === "map_sync_access_requests"
      && operation.action === "update"
      && operation.patch.status === "claimed"
  );
  const keyInsert = operations.find((operation) =>
    operation.table === "map_sync_keys"
      && operation.action === "insert"
  );
  const rollbackUpdate = operations.find((operation) =>
    operation.table === "map_sync_access_requests"
      && operation.action === "update"
      && operation.patch.status === "approved"
  );

  assert.ok(claimUpdate);
  assert.ok(keyInsert);
  assert.ok(rollbackUpdate);
  assert.ok(operations.indexOf(claimUpdate) < operations.indexOf(keyInsert));
  assert.ok(operations.indexOf(keyInsert) < operations.indexOf(rollbackUpdate));
  assert.deepEqual(claimUpdate.filters.slice(-2), [
    ["id", "request-1"],
    ["status", "approved"],
  ]);
  assert.deepEqual(rollbackUpdate.filters.slice(-2), [
    ["id", "request-1"],
    ["status", "claimed"],
  ]);
});

test("map access claim route returns top-level sync key scope", async () => {
  const operations = [];
  const accessRequest = {
    id: "request-1",
    resman_account_id: "1659",
    property_id: "property-1",
    property_name: "Emberly Apartments",
    feature_key: MAP_ANNOTATIONS_FEATURE_KEY,
    requester_display_name: "Jane Staff",
    requester_resman_login_hash: "hmac-sha256:abc",
    device_id: "device-1",
    status: "approved",
    claim_token_hash: hashSecret("claim-secret"),
  };
  const insertedKey = {
    id: "key-1",
    resman_account_id: "1659",
    property_id: "property-1",
    property_name: "Emberly Apartments",
    feature_key: MAP_ANNOTATIONS_FEATURE_KEY,
    capabilities: { read: true, create: true, update: true, delete: true },
    requester_display_name: "Jane Staff",
    device_id: "device-1",
    active: true,
    created_at: "2026-06-29T12:00:00.000Z",
  };
  const scripts = [
    { table: "map_sync_access_requests", select: { data: accessRequest, error: null } },
    { table: "map_sync_keys", select: { data: null, error: null } },
    { table: "map_sync_access_requests", update: { data: { id: "request-1" }, error: null } },
    { table: "map_sync_keys", insert: { data: insertedKey, error: null } },
    { table: "map_annotation_audit_logs", insert: { data: null, error: null } },
  ];
  const route = loadRouteWithMocks("app/api/map/access-requests/[requestId]/claim/route.ts", {
    "@/lib/rate-limit": {
      checkRateLimit: async () => true,
    },
    "@/lib/map-sync": {
      ...require("../lib/map-sync"),
      createSyncKeySecret: () => "emsync_secret",
    },
    "@/lib/supabase/admin": {
      createUntypedAdminClient: () => scriptedSupabase(scripts, operations),
    },
  });

  const response = await route.POST(
    jsonRequest({ deviceId: "device-1", claimToken: "claim-secret" }),
    { params: Promise.resolve({ requestId: "request-1" }) }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.syncKey, "emsync_secret");
  assert.equal(body.propertyId, "property-1");
  assert.equal(body.featureKey, MAP_ANNOTATIONS_FEATURE_KEY);
  assert.deepEqual(body.capabilities, { read: true, create: true, update: true, delete: true });
  assert.equal(body.key.id, "key-1");
});

test("map access claim route rate limits before Supabase lookup", async () => {
  let createAdminClientCalled = false;
  const rateLimitBuckets = [];
  const route = loadRouteWithMocks("app/api/map/access-requests/[requestId]/claim/route.ts", {
    "@/lib/rate-limit": {
      checkRateLimit: async (input) => {
        rateLimitBuckets.push(input.bucket);
        return false;
      },
    },
    "@/lib/supabase/admin": {
      createUntypedAdminClient: () => {
        createAdminClientCalled = true;
        throw new Error("Supabase should not be created while rate limited");
      },
    },
  });

  const response = await route.POST(
    jsonRequest({ deviceId: "device-1", claimToken: "claim-secret" }, { "x-real-ip": "203.0.113.11" }),
    { params: Promise.resolve({ requestId: "request-1" }) }
  );
  const body = await response.json();

  assert.equal(response.status, 429);
  assert.deepEqual(body, { error: "Too many map sync claim attempts" });
  assert.equal(createAdminClientCalled, false);
  assert.equal(rateLimitBuckets[0], "map-access-claim:203.0.113.11");
});

test("admin reject route stores rejection reason on pending requests", async () => {
  const operations = [];
  const accessRequest = {
    id: "request-1",
    resman_account_id: "1659",
    property_id: "property-1",
    property_name: "Emberly Apartments",
    feature_key: MAP_ANNOTATIONS_FEATURE_KEY,
    requester_display_name: "Jane Staff",
    requester_resman_login_hash: "hmac-sha256:abc",
    device_id: "device-1",
    status: "pending",
  };
  const scripts = [
    { table: "map_sync_access_requests", select: { data: accessRequest, error: null } },
    {
      table: "map_sync_access_requests",
      update: {
        data: {
          ...accessRequest,
          status: "rejected",
          rejected_by: "admin-1",
          rejected_at: "2026-06-29T12:00:00.000Z",
          rejection_reason: "Duplicate request",
        },
        error: null,
      },
    },
    { table: "map_annotation_audit_logs", insert: { data: null, error: null } },
  ];
  const route = loadRouteWithMocks("app/api/map/admin/access-requests/[requestId]/reject/route.ts", {
    "@/lib/admin-request": {
      requireAdmin: async () => ({
        ok: true,
        admin: {
          adminId: "admin-1",
          displayName: "Admin User",
          role: "property_manager",
        },
      }),
    },
    "@/lib/supabase/admin": {
      createUntypedAdminClient: () => scriptedSupabase(scripts, operations),
    },
  });

  const response = await route.POST(
    jsonRequest({ rejectionReason: " Duplicate request " }),
    { params: Promise.resolve({ requestId: "request-1" }) }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.request.rejection_reason, "Duplicate request");

  const rejectUpdate = operations.find((operation) =>
    operation.table === "map_sync_access_requests"
      && operation.action === "update"
      && operation.patch.status === "rejected"
  );
  assert.ok(rejectUpdate);
  assert.equal(rejectUpdate.patch.rejection_reason, "Duplicate request");
});

test("map access claim route marks request claimed before minting sync key", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "app/api/map/access-requests/[requestId]/claim/route.ts"),
    "utf8"
  );
  const claimUpdateIndex = source.indexOf(".update(buildClaimedRequestPatch(claimedAt))");
  const keySecretIndex = source.indexOf("const syncKey = createSyncKeySecret()");
  const keyInsertIndex = source.indexOf(".insert(buildSyncKeyInsert(accessRequest, syncKey))");
  const auditErrorIndex = source.indexOf("if (auditError)");
  const returnIndex = source.indexOf("return NextResponse.json({\n      syncKey,");

  assert.notEqual(claimUpdateIndex, -1);
  assert.notEqual(keySecretIndex, -1);
  assert.notEqual(keyInsertIndex, -1);
  assert.notEqual(auditErrorIndex, -1);
  assert.notEqual(returnIndex, -1);
  assert.ok(claimUpdateIndex < keySecretIndex);
  assert.ok(keySecretIndex < keyInsertIndex);
  assert.ok(auditErrorIndex < returnIndex);
  assert.doesNotMatch(source, /return NextResponse\.json\(\{ error: "Failed to audit access claim" \}/);
});

test("map access request route keeps claim token return best-effort when audit fails", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "app/api/map/access-requests/route.ts"),
    "utf8"
  );
  const auditErrorIndex = source.indexOf("if (auditError)");
  const returnIndex = source.indexOf("return NextResponse.json({\n      requestId: insertedRequest.id,");

  assert.notEqual(auditErrorIndex, -1);
  assert.notEqual(returnIndex, -1);
  assert.ok(auditErrorIndex < returnIndex);
  assert.doesNotMatch(source, /Failed to audit access request/);
});

test("map access claim route rolls request back to approved when sync key insert fails", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "app/api/map/access-requests/[requestId]/claim/route.ts"),
    "utf8"
  );
  const keyInsertErrorIndex = source.indexOf("if (keyInsertError || !insertedKey)");
  const rollbackIndex = source.indexOf('.update({ status: "approved", updated_at:');
  const rollbackStatusIndex = source.indexOf('.eq("status", "claimed")', rollbackIndex);
  const failureReturnIndex = source.indexOf('return NextResponse.json({ error: "Failed to create sync key" }', keyInsertErrorIndex);

  assert.notEqual(keyInsertErrorIndex, -1);
  assert.notEqual(rollbackIndex, -1);
  assert.notEqual(rollbackStatusIndex, -1);
  assert.notEqual(failureReturnIndex, -1);
  assert.ok(keyInsertErrorIndex < rollbackIndex);
  assert.ok(rollbackIndex < rollbackStatusIndex);
  assert.ok(rollbackStatusIndex < failureReturnIndex);
});

test("admin access mutation routes treat audit failures as best-effort", () => {
  for (const routePath of [
    "app/api/map/admin/access-requests/[requestId]/approve/route.ts",
    "app/api/map/admin/access-requests/[requestId]/reject/route.ts",
    "app/api/map/admin/sync-keys/[keyId]/revoke/route.ts",
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), routePath), "utf8");
    const auditErrorIndex = source.indexOf("if (auditError)");
    const successReturnIndex = source.lastIndexOf("return NextResponse.json({");

    assert.notEqual(auditErrorIndex, -1);
    assert.notEqual(successReturnIndex, -1);
    assert.ok(auditErrorIndex < successReturnIndex, routePath);
    assert.doesNotMatch(source, /Failed to audit access (approval|rejection|revocation)/);
    assert.doesNotMatch(source, /Failed to audit sync key revocation/);
  }
});

test("schema enforces one active map sync key per scope and device", () => {
  const sql = fs.readFileSync(path.join(process.cwd(), "lib/supabase/schema.sql"), "utf8");

  assert.match(sql, /create unique index if not exists map_sync_keys_active_scope_device_unique_idx/);
  assert.match(
    sql,
    /on public\.map_sync_keys \(resman_account_id, property_id, feature_key, device_id\)\s+where active is true/
  );
});

test("admin map sync page exposes access request and sync key controls", () => {
  const pageSource = fs.readFileSync(
    path.join(process.cwd(), "app/admin/(protected)/map-sync/page.tsx"),
    "utf8"
  );
  const clientSource = fs.readFileSync(
    path.join(process.cwd(), "app/admin/(protected)/map-sync/map-sync-client.tsx"),
    "utf8"
  );
  const source = `${pageSource}\n${clientSource}`;

  for (const visibleText of [
    "Map Data",
    "Pending Access Requests",
    "Active Map Data Keys",
    "Approve",
    "Reject",
    "Revoke",
  ]) {
    assert.match(source, new RegExp(visibleText));
  }
});

test("admin map sync page queries sync access requests, keys, and annotation audit logs", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "app/admin/(protected)/map-sync/page.tsx"),
    "utf8"
  );

  assert.match(source, /createAdminClient/);
  assert.match(source, /dynamic = "force-dynamic"/);
  assert.match(source, /\.from\("map_sync_access_requests"\)/);
  assert.match(source, /\.from\("map_sync_keys"\)/);
  assert.match(source, /\.from\("map_annotation_audit_logs"\)/);
});

test("admin map sync page checks role access before loading service-role data", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "app/admin/(protected)/map-sync/page.tsx"),
    "utf8"
  );

  assert.match(source, /getAdminFromSessionCookie/);
  assert.match(source, /canViewMapSyncAdmin/);
  assert.ok(
    source.indexOf("canViewMapSyncAdmin(admin)") < source.indexOf("await loadMapSyncData()"),
    "page must role-gate before loading Supabase map data"
  );
});

test("admin shell links to map sync", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "app/admin/(protected)/_components/admin-shell.tsx"),
    "utf8"
  );

  assert.match(source, /href: "\/admin\/map-sync", label: "Map Data"/);
});

test("admin map sync actions use the protected admin fetch client", () => {
  const pageSource = fs.readFileSync(
    path.join(process.cwd(), "app/admin/(protected)/map-sync/page.tsx"),
    "utf8"
  );
  const clientSource = fs.readFileSync(
    path.join(process.cwd(), "app/admin/(protected)/map-sync/map-sync-client.tsx"),
    "utf8"
  );

  assert.doesNotMatch(pageSource, /dangerouslySetInnerHTML/);
  assert.match(clientSource, /"use client"/);
  assert.match(clientSource, /fetchAdminJson/);
  assert.match(clientSource, /\/api\/map\/admin\/access-requests\/\$\{request\.id\}\/approve/);
  assert.match(clientSource, /\/api\/map\/admin\/access-requests\/\$\{request\.id\}\/reject/);
  assert.match(clientSource, /\/api\/map\/admin\/sync-keys\/\$\{key\.id\}\/revoke/);
});

// Bun runtime: mock the route's `@/…` dependencies with bun:test's
// `mock.module` (Bun resolves the tsconfig alias in the mock specifier, and
// live ESM bindings inside an already-loaded route pick up each test's fresh
// mock). This replaces the Node-only `Module._resolveFilename` + `require.cache`
// harness, which Bun's runtime does not implement.
//
// NOTE: mock.module is process-global and Bun does not cleanly revert it, so
// this suite is run in its own process (the package.json `test` script runs
// each file separately) to keep these mocks from leaking into other files.
function loadRouteWithMocks(routePath, mocks) {
  for (const [alias, mockExports] of Object.entries(mocks)) {
    mock.module(alias, () => mockExports);
  }

  const routeModulePath = path.join(process.cwd(), routePath);
  // Bust any cached route instance so it re-reads the current mocks (no-op if
  // Bun doesn't populate require.cache for this module — live bindings cover it).
  const resolved = require.resolve(routeModulePath);
  if (require.cache) delete require.cache[resolved];
  return require(routeModulePath);
}

function jsonRequest(body, headers = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    json: async () => body,
    headers: {
      get: (name) => normalizedHeaders[name.toLowerCase()] ?? null,
    },
  };
}

function scriptedSupabase(scripts, operations) {
  return {
    from(table) {
      const script = scripts.shift();
      if (!script) {
        throw new Error(`Unexpected Supabase table ${table}`);
      }
      assert.equal(table, script.table);

      return {
        select(columns) {
          const operation = { table, action: "select", columns, filters: [] };
          operations.push(operation);
          return chainResult(script.select, operation);
        },
        update(patch) {
          const operation = { table, action: "update", patch, filters: [] };
          operations.push(operation);
          return chainResult(script.update, operation);
        },
        insert(row) {
          const operation = { table, action: "insert", row, filters: [] };
          operations.push(operation);
          return chainResult(script.insert, operation);
        },
      };
    },
  };
}

function chainResult(result, operation = null) {
  const query = {
    filters: [],
    selectColumns: [],
    eq(column, value) {
      this.filters.push([column, value]);
      if (operation) operation.filters = this.filters;
      return this;
    },
    select(columns) {
      this.selectColumns.push(columns);
      if (operation) operation.selectColumns = this.selectColumns;
      return this;
    },
    maybeSingle: async () => result,
    single: async () => result,
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return query;
}
