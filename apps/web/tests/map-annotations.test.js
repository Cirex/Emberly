
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { mock } = require("bun:test");

const { MAP_ANNOTATIONS_FEATURE_KEY, hashSecret } = require("../lib/map-sync");
const {
  buildAnnotationAuditInsert,
  buildAnnotationCreateInsert,
  buildAnnotationDeletePatch,
  buildAnnotationResponse,
  buildAnnotationUpdatePatch,
  ensureExpectedVersion,
} = require("../lib/map-annotations");
const { formatAdminAuditAction } = require("../lib/admin-audit-logs");

function syncKey(overrides = {}) {
  return {
    id: "key-1",
    resman_account_id: "1659",
    property_id: "property-1",
    property_name: "Emberly Apartments",
    feature_key: MAP_ANNOTATIONS_FEATURE_KEY,
    capabilities: { read: true, create: true, update: true, delete: true },
    requester_display_name: "Jane Staff",
    requester_resman_login_hash: "hmac-sha256:abc",
    device_id: "device-1",
    ...overrides,
  };
}

function annotationRow(overrides = {}) {
  return {
    id: "annotation-1",
    title: "Gate code",
    notes: "North entry",
    normalized_x: 0.25,
    normalized_y: 0.75,
    color_hex: "#ffcc00",
    kind: "pin",
    utility_type: null,
    points: null,
    line_style: null,
    line_weight: null,
    flow_arrows: null,
    created_by_display_name: "Jane Staff",
    created_at: "2026-06-29T12:00:00.000Z",
    updated_at: "2026-06-29T12:05:00.000Z",
    deleted_at: null,
    version: 2,
    ...overrides,
  };
}

test("annotation create insert scopes rows to sync key feature and actor", () => {
  const row = buildAnnotationCreateInsert(
    syncKey(),
    {
      id: "annotation-1",
      title: "  Gate code  ",
      notes: "  North entry  ",
      normalizedX: -0.5,
      normalizedY: 1.5,
      colorHex: " #ffcc00 ",
    },
    "2026-06-29T12:00:00.000Z",
  );

  assert.deepEqual(row, {
    id: "annotation-1",
    resman_account_id: "1659",
    property_id: "property-1",
    feature_key: MAP_ANNOTATIONS_FEATURE_KEY,
    layer: "staff",
    origin: "sync",
    title: "Gate code",
    notes: "North entry",
    normalized_x: 0,
    normalized_y: 1,
    color_hex: "#ffcc00",
    kind: "pin",
    utility_type: null,
    points: null,
    created_by_key_id: "key-1",
    created_by_display_name: "Jane Staff",
    created_by_resman_login_hash: "hmac-sha256:abc",
    created_at: "2026-06-29T12:00:00.000Z",
    updated_by_key_id: "key-1",
    updated_by_display_name: "Jane Staff",
    updated_at: "2026-06-29T12:00:00.000Z",
    version: 1,
  });
});

test("ensureExpectedVersion throws version_conflict on mismatches", () => {
  assert.doesNotThrow(() => ensureExpectedVersion({ version: 4 }, 4));
  assert.throws(
    () => ensureExpectedVersion({ version: 4 }, 3),
    (error) => error instanceof Error && error.message === "version_conflict",
  );
});

test("annotation update patch trims fields, clamps coordinates, and increments version", () => {
  const patch = buildAnnotationUpdatePatch(
    syncKey(),
    {
      title: "  Updated  ",
      notes: "  New notes  ",
      normalizedX: 1.25,
      normalizedY: -0.25,
      colorHex: " #00ffaa ",
    },
    7,
    "2026-06-29T12:10:00.000Z",
  );

  assert.deepEqual(patch, {
    title: "Updated",
    notes: "New notes",
    normalized_x: 1,
    normalized_y: 0,
    color_hex: "#00ffaa",
    kind: "pin",
    utility_type: null,
    points: null,
    updated_by_key_id: "key-1",
    updated_by_display_name: "Jane Staff",
    updated_at: "2026-06-29T12:10:00.000Z",
    version: 8,
  });
});

test("annotation delete patch soft deletes with sync key actor and increments version", () => {
  const patch = buildAnnotationDeletePatch(syncKey(), 4, "2026-06-29T12:15:00.000Z");

  assert.deepEqual(patch, {
    deleted_by_key_id: "key-1",
    deleted_by_display_name: "Jane Staff",
    deleted_at: "2026-06-29T12:15:00.000Z",
    updated_by_key_id: "key-1",
    updated_by_display_name: "Jane Staff",
    updated_at: "2026-06-29T12:15:00.000Z",
    version: 5,
  });
});

test("annotation audit insert carries scoped sync key actor metadata", () => {
  const audit = buildAnnotationAuditInsert(
    "annotation.update",
    syncKey(),
    "annotation-1",
    { beforeVersion: 2, afterVersion: 3 },
  );

  assert.deepEqual(audit, {
    resman_account_id: "1659",
    property_id: "property-1",
    feature_key: MAP_ANNOTATIONS_FEATURE_KEY,
    action: "annotation.update",
    annotation_id: "annotation-1",
    sync_key_id: "key-1",
    actor_display_name: "Jane Staff",
    actor_resman_login_hash: "hmac-sha256:abc",
    admin_user_id: null,
    admin_display_name: null,
    metadata: { beforeVersion: 2, afterVersion: 3 },
  });
});

test("annotation response maps snake case rows and photos to camel case", () => {
  const dto = buildAnnotationResponse(annotationRow(), [
    {
      id: "photo-1",
      annotation_id: "annotation-1",
      storage_path: "map/annotation/photo.jpg",
      content_type: "image/jpeg",
      byte_size: 12345,
      created_at: "2026-06-29T12:01:00.000Z",
      deleted_at: null,
    },
  ]);

  assert.deepEqual(dto, {
    id: "annotation-1",
    title: "Gate code",
    notes: "North entry",
    normalizedX: 0.25,
    normalizedY: 0.75,
    colorHex: "#ffcc00",
    kind: "pin",
    utilityType: null,
    points: null,
    lineStyle: null,
    lineWeight: null,
    flowArrows: null,
    createdByDisplayName: "Jane Staff",
    createdAt: "2026-06-29T12:00:00.000Z",
    updatedAt: "2026-06-29T12:05:00.000Z",
    deletedAt: null,
    version: 2,
    photos: [
      {
        id: "photo-1",
        annotationId: "annotation-1",
        storagePath: "map/annotation/photo.jpg",
        contentType: "image/jpeg",
        byteSize: 12345,
        createdAt: "2026-06-29T12:01:00.000Z",
        deletedAt: null,
      },
    ],
  });
  assert.deepEqual(buildAnnotationResponse(annotationRow()).photos, []);
});

test("admin audit labels include map sync and annotation actions", () => {
  assert.equal(formatAdminAuditAction("access.request"), "Request map data access");
  assert.equal(formatAdminAuditAction("access.approve"), "Approve map data access");
  assert.equal(formatAdminAuditAction("access.reject"), "Reject map data access");
  assert.equal(formatAdminAuditAction("access.revoke"), "Revoke map data access");
  assert.equal(formatAdminAuditAction("annotation.create"), "Create map annotation");
  assert.equal(formatAdminAuditAction("annotation.update"), "Update map annotation");
  assert.equal(formatAdminAuditAction("annotation.delete"), "Delete map annotation");
});

test("annotation routes hash Authorization bearer secrets and do not accept raw hashes", () => {
  const authSource = fs.readFileSync(path.join(process.cwd(), "lib/map-sync-auth.ts"), "utf8");

  assert.match(authSource, /Authorization/i);
  assert.match(authSource, /Bearer/);
  assert.match(authSource, /hashSecret\(token\)/);
  assert.match(authSource, /\.eq\("key_hash", keyHash\)/);
  assert.doesNotMatch(authSource, /verifySecretHash\(token/);
  assert.doesNotMatch(authSource, /\.eq\("key_hash", token\)/);
  assert.notEqual(hashSecret("client-secret"), "client-secret");

  for (const routePath of [
    "app/api/map/properties/[propertyId]/annotations/route.ts",
    "app/api/map/properties/[propertyId]/annotations/[annotationId]/route.ts",
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), routePath), "utf8");
    assert.match(source, /authenticateMapSyncRequest\(request, propertyId, /);
  }
});

test("annotation sync-key loader enforces property, feature, capability, and last-used update", () => {
  const authSource = fs.readFileSync(path.join(process.cwd(), "lib/map-sync-auth.ts"), "utf8");

  assert.match(authSource, /MAP_ANNOTATIONS_FEATURE_KEY/);
  assert.match(authSource, /isCapabilityAllowed\(syncKey\.capabilities, capability\)/);
  assert.match(authSource, /syncKey\.property_id !== propertyId/);
  assert.match(authSource, /syncKey\.feature_key !== MAP_ANNOTATIONS_FEATURE_KEY/);
  assert.match(authSource, /\.update\(\{ last_used_at: new Date\(\)\.toISOString\(\) \}\)/);
});

test("annotation list route scopes rows and filters deleted records unless since is provided", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "app/api/map/properties/[propertyId]/annotations/route.ts"),
    "utf8",
  );

  assert.match(source, /\.from\("map_annotations"\)/);
  assert.match(source, /\.eq\("resman_account_id", syncKey\.resman_account_id\)/);
  assert.match(source, /\.eq\("property_id", propertyId\)/);
  assert.match(source, /\.eq\("feature_key", MAP_ANNOTATIONS_FEATURE_KEY\)/);
  assert.match(source, /if \(since\)/);
  assert.match(source, /\.gte\("updated_at", since\)/);
  assert.match(source, /\.is\("deleted_at", null\)/);
  assert.match(source, /\.order\("updated_at", \{ ascending: true \}\)/);
});

test("annotation mutation routes audit best-effort and delete only soft-deletes", () => {
  const createSource = fs.readFileSync(
    path.join(process.cwd(), "app/api/map/properties/[propertyId]/annotations/route.ts"),
    "utf8",
  );
  const mutationSource = fs.readFileSync(
    path.join(process.cwd(), "app/api/map/properties/[propertyId]/annotations/[annotationId]/route.ts"),
    "utf8",
  );

  assert.match(createSource, /buildAnnotationAuditInsert\("annotation\.create"/);
  assert.match(mutationSource, /buildAnnotationAuditInsert\("annotation\.update"/);
  assert.match(mutationSource, /buildAnnotationAuditInsert\("annotation\.delete"/);

  for (const source of [createSource, mutationSource]) {
    const auditErrorIndex = source.indexOf("if (auditError)");
    const successReturnIndex = source.lastIndexOf("return NextResponse.json({");
    assert.notEqual(auditErrorIndex, -1);
    assert.notEqual(successReturnIndex, -1);
    assert.ok(auditErrorIndex < successReturnIndex);
    assert.doesNotMatch(source, /Failed to audit annotation/);
  }

  assert.match(mutationSource, /buildAnnotationDeletePatch/);
  assert.doesNotMatch(mutationSource, /\.delete\(\)/);
});

test("annotation update route checks expectedVersion and returns version conflict", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "app/api/map/properties/[propertyId]/annotations/[annotationId]/route.ts"),
    "utf8",
  );

  assert.match(source, /expectedVersion: z\.number\(\)\.int\(\)\.positive\(\)/);
  assert.match(source, /ensureExpectedVersion\(annotation, parsed\.data\.expectedVersion\)/);
  assert.match(source, /reason: "version_conflict"/);
  assert.match(source, /currentVersion: annotation\.version/);
  assert.match(source, /\.eq\("version", parsed\.data\.expectedVersion\)/);
});

test("annotation list route rejects invalid since before Supabase", async () => {
  let createAdminClientCalled = false;
  const route = loadRouteWithMocks("app/api/map/properties/[propertyId]/annotations/route.ts", {
    "@/lib/supabase/admin": {
      createUntypedAdminClient: () => {
        createAdminClientCalled = true;
        throw new Error("Supabase should not be created for invalid since");
      },
    },
  });

  const response = await route.GET(
    jsonRequest(null, {
      authorization: "Bearer emsync_secret",
      url: "https://emberly-web.test/api/map/properties/property-1/annotations?since=not-a-date",
    }),
    { params: Promise.resolve({ propertyId: "property-1" }) }
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, "Invalid since timestamp");
  assert.equal(createAdminClientCalled, false);
});

test("annotation create route returns annotation when audit insert fails", async () => {
  const operations = [];
  const row = annotationRow({
    id: "annotation-2",
    title: "Light out",
    notes: "Near C",
    normalized_x: 0.3,
    normalized_y: 0.4,
    color_hex: "#FF9500",
    version: 1,
  });
  const scripts = [
    { table: "map_sync_keys", select: { data: syncKey(), error: null } },
    { table: "map_sync_keys", update: { data: null, error: null } },
    { table: "map_annotations", insert: { data: row, error: null } },
    { table: "map_annotation_audit_logs", insert: { data: null, error: new Error("audit failed") } },
  ];
  const route = loadRouteWithMocks("app/api/map/properties/[propertyId]/annotations/route.ts", {
    "@/lib/supabase/admin": {
      createUntypedAdminClient: () => scriptedSupabase(scripts, operations),
    },
  });

  const response = await route.POST(
    jsonRequest({
      id: "annotation-2",
      title: "Light out",
      notes: "Near C",
      normalizedX: 0.3,
      normalizedY: 0.4,
      colorHex: "#FF9500",
    }, { authorization: "Bearer emsync_secret" }),
    { params: Promise.resolve({ propertyId: "property-1" }) }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.annotation.id, "annotation-2");

  const keyLookup = operations.find((operation) => operation.table === "map_sync_keys" && operation.action === "select");
  assert.ok(keyLookup);
  assert.deepEqual(keyLookup.filters.slice(-2), [
    ["key_hash", hashSecret("emsync_secret")],
    ["active", true],
  ]);

  const insert = operations.find((operation) => operation.table === "map_annotations" && operation.action === "insert");
  assert.ok(insert);
  assert.equal(insert.row.feature_key, MAP_ANNOTATIONS_FEATURE_KEY);
  assert.equal(insert.row.resman_account_id, "1659");
  assert.equal(insert.row.property_id, "property-1");
});

test("annotation routes require the request device id to match the sync key", async () => {
  const operations = [];
  const scripts = [
    { table: "map_sync_keys", select: { data: syncKey({ device_id: "device-1" }), error: null } },
  ];
  const route = loadRouteWithMocks("app/api/map/properties/[propertyId]/annotations/route.ts", {
    "@/lib/supabase/admin": {
      createUntypedAdminClient: () => scriptedSupabase(scripts, operations),
    },
  });

  const response = await route.GET(
    jsonRequest(null, {
      authorization: "Bearer emsync_secret",
      headers: { "x-device-id": "device-2" },
      url: "https://emberly-web.test/api/map/properties/property-1/annotations",
    }),
    { params: Promise.resolve({ propertyId: "property-1" }) }
  );
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.reason, "device_mismatch");
  assert.equal(
    operations.some((operation) => operation.table === "map_sync_keys" && operation.action === "update"),
    false,
  );
});

test("annotation delete route version-gates soft delete and returns conflict when update misses", async () => {
  const operations = [];
  const existing = annotationRow({ version: 3 });
  const scripts = [
    { table: "map_sync_keys", select: { data: syncKey(), error: null } },
    { table: "map_sync_keys", update: { data: null, error: null } },
    { table: "map_annotations", select: { data: existing, error: null } },
    { table: "map_annotations", update: { data: null, error: null } },
  ];
  const route = loadRouteWithMocks("app/api/map/properties/[propertyId]/annotations/[annotationId]/route.ts", {
    "@/lib/supabase/admin": {
      createUntypedAdminClient: () => scriptedSupabase(scripts, operations),
    },
  });

  const response = await route.DELETE(
    jsonRequest({ expectedVersion: 3 }, { authorization: "Bearer emsync_secret" }),
    { params: Promise.resolve({ propertyId: "property-1", annotationId: "annotation-1" }) }
  );
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.reason, "version_conflict");
  assert.equal(body.currentVersion, 3);

  const deleteUpdate = operations.find((operation) => operation.table === "map_annotations" && operation.action === "update");
  assert.ok(deleteUpdate);
  assert.equal(deleteUpdate.patch.version, 4);
  assert.deepEqual(deleteUpdate.filters.slice(-6), [
    ["resman_account_id", "1659"],
    ["property_id", "property-1"],
    ["feature_key", MAP_ANNOTATIONS_FEATURE_KEY],
    ["in:layer", ["staff", "utility"]],
    ["version", 3],
    ["is:deleted_at", null],
  ]);
});

test("annotation delete route returns conflict before update when loaded version is stale", async () => {
  const operations = [];
  const existing = annotationRow({ version: 3 });
  const scripts = [
    { table: "map_sync_keys", select: { data: syncKey(), error: null } },
    { table: "map_sync_keys", update: { data: null, error: null } },
    { table: "map_annotations", select: { data: existing, error: null } },
  ];
  const route = loadRouteWithMocks("app/api/map/properties/[propertyId]/annotations/[annotationId]/route.ts", {
    "@/lib/supabase/admin": {
      createUntypedAdminClient: () => scriptedSupabase(scripts, operations),
    },
  });

  const response = await route.DELETE(
    jsonRequest({ expectedVersion: 2 }, { authorization: "Bearer emsync_secret" }),
    { params: Promise.resolve({ propertyId: "property-1", annotationId: "annotation-1" }) }
  );
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.reason, "version_conflict");
  assert.equal(body.currentVersion, 3);
  assert.equal(
    operations.some((operation) => operation.table === "map_annotations" && operation.action === "update"),
    false,
  );
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

function jsonRequest(body, options = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  if (options.authorization) {
    normalizedHeaders.authorization = options.authorization;
    normalizedHeaders["x-device-id"] = normalizedHeaders["x-device-id"] ?? "device-1";
  }

  const request = {
    headers: {
      get: (name) => normalizedHeaders[name.toLowerCase()] ?? null,
    },
  };

  if (body !== null) {
    request.json = async () => body;
  }

  if (options.url) {
    request.url = options.url;
    request.nextUrl = new URL(options.url);
  }

  return request;
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
    is(column, value) {
      this.filters.push([`is:${column}`, value]);
      if (operation) operation.filters = this.filters;
      return this;
    },
    in(column, values) {
      this.filters.push([`in:${column}`, values]);
      if (operation) operation.filters = this.filters;
      return this;
    },
    gte(column, value) {
      this.filters.push([`gte:${column}`, value]);
      if (operation) operation.filters = this.filters;
      return this;
    },
    order(column, options) {
      this.orderBy = [column, options];
      if (operation) operation.orderBy = this.orderBy;
      return Promise.resolve(result);
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
