const assert = require("node:assert/strict");
const test = require("node:test");
const { mock } = require("bun:test");
const { NextResponse } = require("next/server");

/**
 * The work-order write path's web half: the edit/close routes queue durable
 * rows into maintenance_work_order_edits (they NEVER touch ResMan inline),
 * and the queue lib keeps one live queued row per (work order, kind).
 *
 * Same harness as tests/lease-notes.test.js: auth and the admin client are
 * stubbed, the routes run for real.
 */

const state = { auth: { ok: false, response: null }, db: null };

mock.module("@/lib/resman-api-auth", () => ({
  requireResmanApiKey: async () => state.auth,
  // resman-api.ts (in the routes' import chain) pulls this re-export too.
  tokenForbiddenForResource: () => false,
}));

mock.module("@/lib/supabase/admin", () => ({
  createAdminClient: () => state.db,
  createUntypedAdminClient: () => state.db,
  getMissingSupabaseAdminEnvVars: () => [],
}));

const { queueWorkOrderWrite, workOrderWriteActor } = require("../lib/work-order-write-queue");
const editRoute = require("../app/api/resman/work-orders/[id]/edit/route.ts");
const closeRoute = require("../app/api/resman/work-orders/[id]/close/route.ts");

const WO = "6f09851a-df4e-488f-a86b-de4a60bd4225";

function tokenAuth() {
  return {
    ok: true,
    kind: "token",
    subject: {
      tokenId: "tok-1",
      kind: "api_resman",
      subjectType: "admin_user",
      subjectId: "admin-9",
      label: "Allan Zelaya",
      role: "maintenance",
      scopes: ["*"],
    },
  };
}

/**
 * In-memory maintenance_work_order_edits + a canned resman_work_orders row.
 * Mimics PostgREST closely enough for the two query shapes the code uses,
 * including the partial-unique index on queued rows.
 */
function makeDb({ workOrderExists = true } = {}) {
  const queue = [];
  let nextId = 1;
  const db = {
    queue,
    failNextInsert: null,
    from(table) {
      if (table === "resman_work_orders") {
        return {
          select() {
            return {
              eq(_column, id) {
                return {
                  async maybeSingle() {
                    return {
                      data:
                        workOrderExists && id === WO
                          ? { resman_work_order_id: WO, status: "Not Started" }
                          : null,
                      error: null,
                    };
                  },
                  or() {
                    return this;
                  },
                };
              },
            };
          },
        };
      }
      if (table !== "maintenance_work_order_edits") throw new Error(`unexpected table ${table}`);
      return {
        update(fields) {
          const chain = {
            filters: [],
            eq(column, value) {
              chain.filters.push([column, value]);
              return chain;
            },
            async select() {
              const matched = queue.filter((row) =>
                chain.filters.every(([column, value]) => row[column] === value),
              );
              for (const row of matched) Object.assign(row, fields);
              return { data: matched.map((row) => ({ id: row.id })), error: null };
            },
          };
          return chain;
        },
        insert(fields) {
          return {
            select() {
              return {
                async single() {
                  if (db.failNextInsert) {
                    const error = db.failNextInsert;
                    db.failNextInsert = null;
                    return { data: null, error };
                  }
                  const duplicate = queue.some(
                    (row) =>
                      row.resman_work_order_id === fields.resman_work_order_id &&
                      row.kind === fields.kind &&
                      row.status === "queued",
                  );
                  if (duplicate) {
                    return { data: null, error: { code: "23505", message: "duplicate key" } };
                  }
                  const row = { id: `q-${nextId++}`, status: "queued", attempts: 0, ...fields };
                  queue.push(row);
                  return { data: { id: row.id }, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  return db;
}

const actor = { requestedBy: "Allan Zelaya", requestedByRole: "maintenance", requestedByAdminId: "admin-9" };

// MARK: - The queue lib

test("queue: first write inserts a queued row", async () => {
  const db = makeDb();
  const result = await queueWorkOrderWrite(db, {
    workOrderId: WO,
    kind: "close",
    patch: { note: "done" },
    actor,
  });
  assert.equal(result.replaced, false);
  assert.equal(db.queue.length, 1);
  assert.equal(db.queue[0].status, "queued");
  assert.equal(db.queue[0].requested_by, "Allan Zelaya");
});

test("queue: a retry replaces the queued row instead of stacking a duplicate", async () => {
  const db = makeDb();
  await queueWorkOrderWrite(db, { workOrderId: WO, kind: "edit", patch: { description: "v1" }, actor });
  const second = await queueWorkOrderWrite(db, {
    workOrderId: WO,
    kind: "edit",
    patch: { description: "v2" },
    actor,
  });
  assert.equal(second.replaced, true);
  assert.equal(db.queue.length, 1);
  assert.deepEqual(db.queue[0].patch, { description: "v2" });
  assert.equal(db.queue[0].attempts, 0, "a replaced row starts its retry budget over");
});

test("queue: different kinds queue independently", async () => {
  const db = makeDb();
  await queueWorkOrderWrite(db, { workOrderId: WO, kind: "edit", patch: { description: "x" }, actor });
  await queueWorkOrderWrite(db, { workOrderId: WO, kind: "close", patch: {}, actor });
  assert.equal(db.queue.length, 2);
});

test("queue: an applying row is left alone — the new request becomes a fresh row", async () => {
  const db = makeDb();
  await queueWorkOrderWrite(db, { workOrderId: WO, kind: "close", patch: { note: "v1" }, actor });
  db.queue[0].status = "applying"; // the flusher claimed it
  await queueWorkOrderWrite(db, { workOrderId: WO, kind: "close", patch: { note: "v2" }, actor });
  assert.equal(db.queue.length, 2);
  assert.deepEqual(db.queue[0].patch, { note: "v1" }, "in-flight write not tampered with");
  assert.equal(db.queue[1].status, "queued");
});

test("queue: losing the unique-index race falls back to replacing", async () => {
  const db = makeDb();
  await queueWorkOrderWrite(db, { workOrderId: WO, kind: "close", patch: { note: "first" }, actor });
  // Simulate: replace-first found nothing (raced), insert hits 23505.
  const realFrom = db.from.bind(db);
  let updateCalls = 0;
  db.from = (table) => {
    const real = realFrom(table);
    if (table !== "maintenance_work_order_edits") return real;
    return {
      ...real,
      update(fields) {
        updateCalls += 1;
        if (updateCalls === 1) {
          // First replace attempt sees nothing (the race window).
          return {
            eq() {
              return this;
            },
            async select() {
              return { data: [], error: null };
            },
          };
        }
        return real.update(fields);
      },
    };
  };
  const result = await queueWorkOrderWrite(db, {
    workOrderId: WO,
    kind: "close",
    patch: { note: "second" },
    actor,
  });
  assert.equal(result.replaced, true);
  assert.equal(db.queue.length, 1);
  assert.deepEqual(db.queue[0].patch, { note: "second" });
});

test("workOrderWriteActor: label + role + admin id from the token subject", () => {
  assert.deepEqual(workOrderWriteActor(tokenAuth()), actor);
  const scannerish = tokenAuth();
  scannerish.subject.subjectType = "scanner";
  assert.equal(workOrderWriteActor(scannerish).requestedByAdminId, "");
});

// MARK: - The routes

function request(body) {
  return new Request("http://localhost/api/resman/work-orders/x", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
const ctx = { params: Promise.resolve({ id: WO }) };

test("edit route: queues the patch and answers queued (no stub flag)", async () => {
  state.auth = tokenAuth();
  state.db = makeDb();
  const response = await editRoute.POST(request({ description: "Fix the disposal" }), ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, queued: true });
  assert.equal(state.db.queue.length, 1);
  assert.equal(state.db.queue[0].kind, "edit");
  assert.deepEqual(state.db.queue[0].patch, { description: "Fix the disposal" });
});

test("close route: queues note + completedAt and stamps the actor", async () => {
  state.auth = tokenAuth();
  state.db = makeDb();
  const response = await closeRoute.POST(
    request({ note: "Relit", completedAt: "2026-08-21T15:00:00.000Z" }),
    ctx,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, queued: true });
  const row = state.db.queue[0];
  assert.equal(row.kind, "close");
  assert.deepEqual(row.patch, { note: "Relit", completedAt: "2026-08-21T15:00:00.000Z" });
  assert.equal(row.requested_by, "Allan Zelaya");
  assert.equal(row.requested_by_admin_id, "admin-9");
});

test("routes: an unknown work order 404s and queues nothing", async () => {
  state.auth = tokenAuth();
  state.db = makeDb({ workOrderExists: false });
  const response = await closeRoute.POST(request({ note: "x" }), ctx);
  assert.equal(response.status, 404);
  assert.equal(state.db.queue.length, 0);
});

test("routes: scanners may not write work orders", async () => {
  state.auth = { ok: true, kind: "scanner" };
  state.db = makeDb();
  for (const route of [editRoute, closeRoute]) {
    const response = await route.POST(request({ note: "x", description: "x" }), ctx);
    assert.equal(response.status, 403);
  }
  assert.equal(state.db.queue.length, 0);
});

test("edit route: an empty patch is a 400, not an empty queue row", async () => {
  state.auth = tokenAuth();
  state.db = makeDb();
  const response = await editRoute.POST(request({ bogus: true }), ctx);
  assert.equal(response.status, 400);
  assert.equal(state.db.queue.length, 0);
});

test("routes: unauthenticated callers get the auth response", async () => {
  state.auth = { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  state.db = makeDb();
  const response = await editRoute.POST(request({ description: "x" }), ctx);
  assert.equal(response.status, 401);
});
