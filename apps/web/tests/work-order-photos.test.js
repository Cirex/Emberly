const assert = require("node:assert/strict");
const test = require("node:test");
const { mock } = require("bun:test");
const { NextResponse } = require("next/server");
const { tokenForbiddenForResource } = require("../lib/app-role-capabilities");

// Same bun:test mock.module harness as tests/map-annotations.test.js — this
// suite runs in its own process (the package.json `test` script runs each file
// separately), so the process-global mocks cannot leak into other files. The
// mocks are installed before the lib/routes are required so every consumer
// resolves them.
const state = {
  /** What requireResmanApiKey answers. */
  auth: { ok: false, response: null },
  /** What getResource answers (the work-order existence check). */
  workOrderRow: null,
  /** Scripted untyped Supabase client. */
  db: null,
  /** Fake storage bucket handle. */
  storage: null,
};

mock.module("@/lib/resman-api-auth", () => ({
  requireResmanApiKey: async () => state.auth,
  // Only AUTHENTICATION is stubbed. The allow/deny decision runs the real
  // policy from lib/app-role-capabilities.ts, so a route wired to the wrong
  // capability fails here rather than quietly passing a stubbed check.
  requireStaffToken: async (_request, capability) => {
    if (!state.auth.ok) return state.auth;
    if (state.auth.kind === "scanner" || tokenForbiddenForResource(state.auth.subject, capability)) {
      return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
    return state.auth;
  },
}));

mock.module("@/lib/resman-api", () => ({
  getResource: async () => state.workOrderRow,
}));

mock.module("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => state.storage } }),
  createUntypedAdminClient: () => state.db,
  getMissingSupabaseAdminEnvVars: () => [],
}));

const {
  MAX_WORK_ORDER_PHOTO_BYTES,
  WORK_ORDER_PHOTOS_BUCKET,
  WORK_ORDER_PHOTO_PHASES,
  validateWorkOrderPhotoUpload,
  workOrderPhotoActor,
  workOrderPhotoStoragePath,
} = require("../lib/work-order-photos");
const photosRoute = require("../app/api/resman/work-orders/[id]/photos/route.ts");
const photoRoute = require("../app/api/resman/work-order-photos/[photoId]/route.ts");

// --- shared fakes ---------------------------------------------------------

function tokenAuth(overrides = {}) {
  return {
    ok: true,
    kind: "token",
    subject: {
      tokenId: "token-1",
      kind: "api_resman",
      subjectType: "admin_user",
      subjectId: "admin-7",
      label: "Marcus Tech",
      role: "security_manager",
      scopes: [],
      ...overrides,
    },
  };
}

function untouchableDb() {
  return {
    from() {
      throw new Error("Supabase must not be touched before auth");
    },
  };
}

function fakeStorage() {
  const calls = { uploads: [], removals: [], downloads: [] };
  return {
    calls,
    upload: async (path, bytes, options) => {
      calls.uploads.push({ path, byteLength: bytes.length, options });
      return { data: { path }, error: null };
    },
    remove: async (paths) => {
      calls.removals.push(paths);
      return { data: null, error: null };
    },
    download: async (path) => {
      calls.downloads.push(path);
      return { data: new Blob([Buffer.from("image-bytes")]), error: null };
    },
  };
}

function scriptedSupabase(scripts, operations) {
  return {
    from(table) {
      const script = scripts.shift();
      if (!script) throw new Error(`Unexpected Supabase table ${table}`);
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

function photoRow(overrides = {}) {
  return {
    id: "photo-1",
    resman_work_order_id: "wo-1",
    phase: "completion",
    content_type: "image/jpeg",
    byte_size: 3,
    created_by: "Marcus Tech",
    created_at: "2026-07-21T12:00:00.000Z",
    storage_path: "wo-1/photo-1.jpg",
    ...overrides,
  };
}

function uploadRequest(body) {
  return new Request("https://emberly-web.test/api/resman/work-orders/wo-1/photos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const listParams = { params: Promise.resolve({ id: "wo-1" }) };
const photoParams = { params: Promise.resolve({ photoId: "photo-1" }) };
const JPEG_BASE64 = Buffer.from("img").toString("base64");

// --- pure validation ------------------------------------------------------

test("photo validation accepts jpeg/png/webp within the 10MB cap and known phases", () => {
  assert.equal(MAX_WORK_ORDER_PHOTO_BYTES, 10 * 1024 * 1024);
  for (const contentType of ["image/jpeg", "image/png", "image/webp"]) {
    assert.deepEqual(
      validateWorkOrderPhotoUpload({ contentType, byteSize: MAX_WORK_ORDER_PHOTO_BYTES, phase: undefined }),
      { ok: true },
    );
  }
  for (const phase of WORK_ORDER_PHOTO_PHASES) {
    assert.deepEqual(
      validateWorkOrderPhotoUpload({ contentType: "image/jpeg", byteSize: 1024, phase }),
      { ok: true },
    );
  }
});

test("photo validation rejects other types, empty/oversized payloads, and bad phases", () => {
  const reject = (input) => {
    const result = validateWorkOrderPhotoUpload(input);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    return result.error;
  };
  assert.equal(reject({ contentType: "image/heic", byteSize: 1024, phase: undefined }), "Unsupported image type");
  assert.equal(reject({ contentType: "application/pdf", byteSize: 1024, phase: undefined }), "Unsupported image type");
  assert.equal(reject({ contentType: "image/jpeg", byteSize: 0, phase: undefined }), "Image is empty or too large");
  assert.equal(
    reject({ contentType: "image/jpeg", byteSize: MAX_WORK_ORDER_PHOTO_BYTES + 1, phase: undefined }),
    "Image is empty or too large",
  );
  assert.equal(reject({ contentType: "image/jpeg", byteSize: 1024, phase: "during" }), "Invalid phase");
});

test("storage paths are scoped to the work order and content type", () => {
  assert.equal(WORK_ORDER_PHOTOS_BUCKET, "work-order-photos");
  assert.equal(
    workOrderPhotoStoragePath({ workOrderId: "wo-1", photoId: "p1", contentType: "image/jpeg" }),
    "wo-1/p1.jpg",
  );
  assert.equal(
    workOrderPhotoStoragePath({ workOrderId: "wo-1", photoId: "p2", contentType: "image/png" }),
    "wo-1/p2.png",
  );
  assert.equal(
    workOrderPhotoStoragePath({ workOrderId: "wo-1", photoId: "p3", contentType: "image/webp" }),
    "wo-1/p3.webp",
  );
});

test("actor attribution follows the auth subject", () => {
  assert.deepEqual(workOrderPhotoActor(tokenAuth()), {
    createdBy: "Marcus Tech",
    createdByAdminId: "admin-7",
  });
  // A token whose subject is a scanner device keeps its label but no admin id.
  assert.deepEqual(
    workOrderPhotoActor(tokenAuth({ subjectType: "scanner", subjectId: "scanner-1", label: "Gate iPad" })),
    { createdBy: "Gate iPad", createdByAdminId: "" },
  );
  assert.deepEqual(workOrderPhotoActor({ ok: true, kind: "scanner" }), {
    createdBy: "scanner",
    createdByAdminId: "",
  });
});

// --- auth gating ----------------------------------------------------------

test("every photo route is gated by resman API auth and touches nothing when it fails", async () => {
  state.auth = { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  state.db = untouchableDb();
  state.storage = fakeStorage();

  const attempts = [
    photosRoute.GET(new Request("https://emberly-web.test/api/resman/work-orders/wo-1/photos"), listParams),
    photosRoute.POST(uploadRequest({ dataBase64: JPEG_BASE64, contentType: "image/jpeg" }), listParams),
    photoRoute.GET(new Request("https://emberly-web.test/api/resman/work-order-photos/photo-1"), photoParams),
    photoRoute.DELETE(
      new Request("https://emberly-web.test/api/resman/work-order-photos/photo-1", { method: "DELETE" }),
      photoParams,
    ),
  ];
  for (const attempt of attempts) {
    const response = await attempt;
    assert.equal(response.status, 401);
  }
  assert.equal(state.storage.calls.uploads.length, 0);
});

test("a gate scanner cannot read, upload or DELETE completion photos", async () => {
  // These are pictures of the inside of a resident's home. Every handler here
  // used to accept any authenticated caller, and a scanner credential is
  // authenticated — a shared key on a wall by the gate could stream them and
  // soft-delete them. The upload handler LOOKED gated (it forwarded
  // `auth.kind === "scanner"` into getResource) but getResource only narrows
  // when the resource declares `scannerVisible`, and work-orders does not.
  state.auth = { ok: true, kind: "scanner" };
  state.db = untouchableDb();
  state.workOrderRow = { resman_work_order_id: "wo-1" };
  state.storage = fakeStorage();

  const attempts = [
    photosRoute.GET(new Request("https://emberly-web.test/api/resman/work-orders/wo-1/photos"), listParams),
    photosRoute.POST(uploadRequest({ dataBase64: JPEG_BASE64, contentType: "image/jpeg" }), listParams),
    photoRoute.GET(new Request("https://emberly-web.test/api/resman/work-order-photos/photo-1"), photoParams),
    photoRoute.DELETE(
      new Request("https://emberly-web.test/api/resman/work-order-photos/photo-1", { method: "DELETE" }),
      photoParams,
    ),
  ];
  for (const attempt of attempts) {
    assert.equal((await attempt).status, 403);
  }
  assert.equal(state.storage.calls.uploads.length, 0);
});

test("the maintenance app's own token still reaches its photos", async () => {
  // The gate above must not cost the app the surface it exists for: the
  // maintenance token's role allows `work-orders`, which is what these routes
  // are gated on.
  state.auth = tokenAuth({ role: "security_manager", scopes: ["units", "work-orders"] });
  state.workOrderRow = { resman_work_order_id: "wo-1" };
  state.storage = fakeStorage();
  state.db = scriptedSupabase(
    [{ table: "work_order_photos", insert: { data: photoRow(), error: null } }],
    [],
  );
  const response = await photosRoute.POST(
    uploadRequest({ dataBase64: JPEG_BASE64, contentType: "image/jpeg" }),
    listParams,
  );
  assert.equal(response.status, 201);
});

// --- upload ---------------------------------------------------------------

test("upload rejects unsupported content types and malformed payloads", async () => {
  state.auth = tokenAuth();
  state.workOrderRow = { resman_work_order_id: "wo-1" };
  state.storage = fakeStorage();
  state.db = untouchableDb();

  const badType = await photosRoute.POST(
    uploadRequest({ dataBase64: JPEG_BASE64, contentType: "application/pdf" }),
    listParams,
  );
  assert.equal(badType.status, 400);
  assert.equal((await badType.json()).error, "Unsupported image type");

  const badPhase = await photosRoute.POST(
    uploadRequest({ dataBase64: JPEG_BASE64, contentType: "image/jpeg", phase: "during" }),
    listParams,
  );
  assert.equal(badPhase.status, 400);
  assert.equal((await badPhase.json()).error, "Invalid photo payload");

  const noBody = await photosRoute.POST(
    new Request("https://emberly-web.test/api/resman/work-orders/wo-1/photos", { method: "POST" }),
    listParams,
  );
  assert.equal(noBody.status, 400);

  assert.equal(state.storage.calls.uploads.length, 0);
});

test("upload answers 404 when the work order does not exist", async () => {
  state.auth = tokenAuth();
  state.workOrderRow = null;
  state.storage = fakeStorage();
  state.db = untouchableDb();

  const response = await photosRoute.POST(
    uploadRequest({ dataBase64: JPEG_BASE64, contentType: "image/jpeg" }),
    listParams,
  );
  assert.equal(response.status, 404);
  assert.equal(state.storage.calls.uploads.length, 0);
});

test("upload stores the bytes, records attribution, and defaults phase to completion", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.workOrderRow = { resman_work_order_id: "wo-1" };
  state.storage = fakeStorage();
  state.db = scriptedSupabase(
    [{ table: "work_order_photos", insert: { data: photoRow(), error: null } }],
    operations,
  );

  const response = await photosRoute.POST(
    uploadRequest({ dataBase64: JPEG_BASE64, contentType: "image/jpeg" }),
    listParams,
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(body, {
    data: { id: "photo-1", phase: "completion", createdAt: "2026-07-21T12:00:00.000Z" },
  });

  assert.equal(state.storage.calls.uploads.length, 1);
  const upload = state.storage.calls.uploads[0];
  assert.match(upload.path, /^wo-1\/[0-9a-f-]{36}\.jpg$/);
  assert.equal(upload.byteLength, 3);
  assert.deepEqual(upload.options, { contentType: "image/jpeg", upsert: false });

  const insert = operations.find((operation) => operation.action === "insert");
  assert.ok(insert);
  assert.equal(insert.row.resman_work_order_id, "wo-1");
  assert.equal(insert.row.phase, "completion");
  assert.equal(insert.row.content_type, "image/jpeg");
  assert.equal(insert.row.byte_size, 3);
  assert.equal(insert.row.created_by, "Marcus Tech");
  assert.equal(insert.row.created_by_admin_id, "admin-7");
  assert.equal(insert.row.storage_path, upload.path);
});

test("upload honors an explicit before/after phase", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.workOrderRow = { resman_work_order_id: "wo-1" };
  state.storage = fakeStorage();
  state.db = scriptedSupabase(
    [{ table: "work_order_photos", insert: { data: photoRow({ phase: "before" }), error: null } }],
    operations,
  );

  const response = await photosRoute.POST(
    uploadRequest({ dataBase64: JPEG_BASE64, contentType: "image/jpeg", phase: "before" }),
    listParams,
  );
  assert.equal(response.status, 201);
  assert.equal((await response.json()).data.phase, "before");
  assert.equal(operations.find((operation) => operation.action === "insert").row.phase, "before");
});

// --- listing + soft delete ------------------------------------------------

test("listing returns only non-deleted photos, newest first", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [
      {
        table: "work_order_photos",
        select: {
          data: [photoRow({ id: "photo-2", created_at: "2026-07-21T13:00:00.000Z" }), photoRow()],
          error: null,
        },
      },
    ],
    operations,
  );

  const response = await photosRoute.GET(
    new Request("https://emberly-web.test/api/resman/work-orders/wo-1/photos"),
    listParams,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data.map((photo) => photo.id), ["photo-2", "photo-1"]);
  assert.deepEqual(Object.keys(body.data[0]), [
    "id",
    "phase",
    "contentType",
    "byteSize",
    "createdBy",
    "createdAt",
  ]);

  const select = operations[0];
  assert.deepEqual(select.filters, [
    ["resman_work_order_id", "wo-1"],
    ["is:deleted_at", null],
  ]);
  assert.deepEqual(select.orderBy, ["created_at", { ascending: false }]);
});

test("serve streams the stored bytes with the recorded content type", async () => {
  state.auth = tokenAuth();
  state.storage = fakeStorage();
  state.db = scriptedSupabase([
    { table: "work_order_photos", select: { data: photoRow(), error: null } },
  ], []);

  const response = await photoRoute.GET(
    new Request("https://emberly-web.test/api/resman/work-order-photos/photo-1"),
    photoParams,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "image-bytes");
  assert.deepEqual(state.storage.calls.downloads, ["wo-1/photo-1.jpg"]);
});

test("delete soft-deletes: sets deleted_at, and the photo stops resolving", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.storage = fakeStorage();
  state.db = scriptedSupabase(
    [
      { table: "work_order_photos", select: { data: photoRow(), error: null } },
      { table: "work_order_photos", update: { data: null, error: null } },
    ],
    operations,
  );

  const response = await photoRoute.DELETE(
    new Request("https://emberly-web.test/api/resman/work-order-photos/photo-1", { method: "DELETE" }),
    photoParams,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });

  const update = operations.find((operation) => operation.action === "update");
  assert.ok(update);
  assert.match(update.patch.deleted_at, /^2026-/);
  assert.deepEqual(update.filters, [["id", "photo-1"]]);
  // The object is removed best-effort; the soft-deleted row is the record.
  assert.deepEqual(state.storage.calls.removals, [["wo-1/photo-1.jpg"]]);

  // A soft-deleted photo no longer resolves (the deleted_at filter hides it).
  state.db = scriptedSupabase([
    { table: "work_order_photos", select: { data: null, error: null } },
  ], []);
  const gone = await photoRoute.GET(
    new Request("https://emberly-web.test/api/resman/work-order-photos/photo-1"),
    photoParams,
  );
  assert.equal(gone.status, 404);
});
