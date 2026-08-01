
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { mock } = require("bun:test");
const { z } = require("zod");

const {
  annotationKindFields,
  isUtilityKind,
  validateAnnotationKindFields,
} = require("../lib/map-annotation-kinds");
const { buildAnnotationResponse } = require("../lib/map-annotations");
const { layersFor } = require("../lib/map-annotation-service");

// The same composition every annotation body schema uses.
const KindSchema = z.object({ ...annotationKindFields }).superRefine(validateAnnotationKindFields);

function layeredRow(overrides = {}) {
  return {
    id: "annotation-9",
    title: "Water main",
    notes: "",
    normalized_x: 0.5,
    normalized_y: 0.5,
    color_hex: "#0044ff",
    kind: "utility_pin",
    utility_type: "water",
    points: null,
    icon: "document-text",
    layer: "utility",
    origin: "scanner",
    created_by_display_name: "Gate iPad",
    created_at: "2026-07-21T12:00:00.000Z",
    updated_at: "2026-07-21T12:00:00.000Z",
    deleted_at: null,
    version: 1,
    ...overrides,
  };
}

test("kind defaults to pin and utility fields must then be absent", () => {
  const defaulted = KindSchema.safeParse({});
  assert.equal(defaulted.success, true);
  assert.equal(defaulted.data.kind, "pin");
  assert.equal(isUtilityKind(defaulted.data.kind), false);

  assert.equal(KindSchema.safeParse({ kind: "pin", utilityType: null, points: null }).success, true);
  assert.equal(KindSchema.safeParse({ utilityType: "water" }).success, false);
  assert.equal(KindSchema.safeParse({ kind: "pin", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }).success, false);
  assert.equal(KindSchema.safeParse({ kind: "gazebo" }).success, false);
});

test("utility_pin requires utilityType and forbids points", () => {
  assert.equal(KindSchema.safeParse({ kind: "utility_pin" }).success, false);
  assert.equal(KindSchema.safeParse({ kind: "utility_pin", utilityType: null }).success, false);
  assert.equal(KindSchema.safeParse({ kind: "utility_pin", utilityType: "steam" }).success, false);
  assert.equal(KindSchema.safeParse({ kind: "utility_pin", utilityType: "gas" }).success, true);
  assert.equal(
    KindSchema.safeParse({ kind: "utility_pin", utilityType: "gas", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }).success,
    false,
  );
});

test("utility_line requires utilityType and 2..200 in-range points", () => {
  const line = (points) => KindSchema.safeParse({ kind: "utility_line", utilityType: "sewer", points });

  assert.equal(KindSchema.safeParse({ kind: "utility_line", utilityType: "sewer" }).success, false);
  assert.equal(KindSchema.safeParse({ kind: "utility_line", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }).success, false);
  assert.equal(line(null).success, false);
  assert.equal(line([{ x: 0.1, y: 0.2 }]).success, false);
  assert.equal(line([{ x: 0.1, y: 0.2 }, { x: 1.5, y: 0.2 }]).success, false);
  assert.equal(line([{ x: 0.1, y: -0.2 }, { x: 0.5, y: 0.2 }]).success, false);
  assert.equal(line([{ x: 0.1 }, { x: 0.5, y: 0.2 }]).success, false);
  assert.equal(line(Array.from({ length: 201 }, () => ({ x: 0.5, y: 0.5 }))).success, false);
  assert.equal(line([{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.9 }]).success, true);
  assert.equal(line(Array.from({ length: 200 }, () => ({ x: 0.5, y: 0.5 }))).success, true);
});

test("run presentation fields parse on a line, default to absent, and are rejected elsewhere", () => {
  const line = {
    kind: "utility_line",
    utilityType: "sewer",
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.9 },
    ],
  };

  // Absent fields parse (older clients keep working) …
  const bare = KindSchema.safeParse(line);
  assert.equal(bare.success, true);
  assert.equal(bare.data.lineStyle, undefined);

  // … present fields round the contract …
  const styled = KindSchema.safeParse({
    ...line,
    lineStyle: "dotted",
    lineWeight: "thick",
    flowArrows: true,
  });
  assert.equal(styled.success, true);
  assert.equal(styled.data.lineStyle, "dotted");
  assert.equal(styled.data.lineWeight, "thick");
  assert.equal(styled.data.flowArrows, true);

  // … out-of-vocabulary values are rejected …
  assert.equal(KindSchema.safeParse({ ...line, lineStyle: "double" }).success, false);
  assert.equal(KindSchema.safeParse({ ...line, lineWeight: "hairline" }).success, false);

  // … and style fields are meaningless off a line.
  assert.equal(
    KindSchema.safeParse({ kind: "utility_pin", utilityType: "gas", lineStyle: "dashed" }).success,
    false,
  );
  assert.equal(KindSchema.safeParse({ kind: "pin", flowArrows: true }).success, false);
});



test("both surfaces list the shared utility layer alongside their own", () => {
  assert.deepEqual(layersFor({ adminId: "scanner:device-1" }), ["security", "utility"]);
  assert.deepEqual(layersFor({ adminId: "admin-1" }), ["staff", "security", "utility"]);
});


test("admin create route forces scanner utility pins onto the utility layer", async () => {
  const operations = [];
  const scripts = [
    { table: "map_annotations", insert: { data: layeredRow(), error: null } },
    { table: "map_annotation_audit_logs", insert: { data: null, error: null } },
  ];
  const route = loadAdminRouteWithMocks(
    { adminId: "scanner:device-1", displayName: "Gate iPad" },
    () => scriptedSupabase(scripts, operations),
  );

  const response = await route.POST(jsonRequest({
    title: "Water main",
    normalizedX: 0.5,
    normalizedY: 0.5,
    colorHex: "#0044ff",
    kind: "utility_pin",
    utilityType: "water",
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.annotation.kind, "utility_pin");
  assert.equal(body.annotation.utilityType, "water");
  assert.equal(body.annotation.points, null);
  assert.equal(body.annotation.layer, "utility");

  const insert = operations.find((operation) => operation.table === "map_annotations" && operation.action === "insert");
  assert.ok(insert);
  assert.equal(insert.row.layer, "utility");
  assert.equal(insert.row.kind, "utility_pin");
  assert.equal(insert.row.utility_type, "water");
  assert.equal(insert.row.points, null);
  assert.equal(insert.row.origin, "scanner");
});

test("admin create route rejects utility annotations missing utilityType or points", async () => {
  let supabaseCreated = false;
  const route = loadAdminRouteWithMocks({ adminId: "admin-1", displayName: "Admin" }, () => {
    supabaseCreated = true;
    throw new Error("Supabase should not be created for invalid bodies");
  });

  const base = { title: "Bad", normalizedX: 0.5, normalizedY: 0.5, colorHex: "#0044ff" };
  for (const body of [
    { ...base, kind: "utility_pin" },
    { ...base, kind: "utility_line", utilityType: "sewer" },
    { ...base, kind: "utility_line", utilityType: "sewer", points: [{ x: 0.1, y: 0.1 }] },
    { ...base, kind: "pin", utilityType: "water" },
    { ...base, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] },
  ]) {
    const response = await route.POST(jsonRequest(body));
    assert.equal(response.status, 400);
  }
  assert.equal(supabaseCreated, false);
});


// Same bun:test mock.module harness as tests/map-annotations.test.js — this
// suite runs in its own process (the package.json `test` script runs each file
// separately), so the process-global mocks cannot leak into other files.
function loadRouteWithMocks(routePath, mocks) {
  for (const [alias, mockExports] of Object.entries(mocks)) {
    mock.module(alias, () => mockExports);
  }

  const routeModulePath = path.join(process.cwd(), routePath);
  const resolved = require.resolve(routeModulePath);
  if (require.cache) delete require.cache[resolved];
  return require(routeModulePath);
}

function loadAdminRouteWithMocks(admin, createClient) {
  return loadRouteWithMocks("app/api/admin/map-annotations/route.ts", {
    "@/lib/admin-request": {
      requireAdminOrScanner: async () => ({ ok: true, admin }),
    },
    "@/lib/supabase/admin": {
      createAdminClient: createClient,
      createUntypedAdminClient: createClient,
    },
  });
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
    url: options.url ?? "https://emberly-web.test/api/admin/map-annotations",
  };
  request.nextUrl = new URL(request.url);

  if (body !== null) {
    request.json = async () => body;
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
