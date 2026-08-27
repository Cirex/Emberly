const assert = require("node:assert/strict");
const test = require("node:test");

const { flushWorkOrderWrites, WRITE_MAX_ATTEMPTS } = require("../src/resman/jobs/flush-work-order-writes");
const { WorkOrderWriteRefused } = require("../src/resman/write/work-orders");
const { ResManScrapingError } = require("../src/resman/errors");

/**
 * Queue-drain semantics: claims, retries, and — most importantly — the
 * one-way doors. A row whose POST went out but could not be confirmed must
 * NEVER be blind-retried; a row a guard refused must never come back.
 */

const WO_A = "6f09851a-df4e-488f-a86b-de4a60bd4225";
const NOW = () => new Date("2026-08-26T20:00:00Z");

/** In-memory maintenance_work_order_edits + resman_work_orders stub. */
function makeDb({ queue = [], workOrders = {} } = {}) {
  const rows = queue.map((row, index) => ({
    id: `row-${index}`,
    kind: "close",
    patch: {},
    status: "queued",
    attempts: 0,
    created_at: "2026-08-26T19:00:00Z",
    updated_at: "2026-08-26T19:00:00Z",
    ...row,
  }));
  const updates = [];
  const db = {
    rows,
    updates,
    from(table) {
      if (table === "maintenance_work_order_edits") {
        return {
          select() {
            return {
              in(_column, statuses) {
                return {
                  order() {
                    return {
                      async limit() {
                        // Copies, not references — PostgREST hands back data,
                        // and the flush's retry math depends on reading the
                        // PRE-claim attempts value.
                        return {
                          data: rows
                            .filter((row) => statuses.includes(row.status))
                            .map((row) => ({ ...row })),
                          error: null,
                        };
                      },
                    };
                  },
                };
              },
            };
          },
          update(fields) {
            const chain = {
              filters: [],
              eq(column, value) {
                this.filters.push([column, value]);
                return this;
              },
              async select() {
                const matched = rows.filter((row) =>
                  chain.filters.every(([column, value]) => row[column] === value),
                );
                for (const row of matched) Object.assign(row, fields);
                updates.push({ fields, filters: chain.filters, matched: matched.length });
                return { data: matched.map((row) => ({ id: row.id })), error: null };
              },
              // update().eq().eq() awaited directly (no .select()).
              then(resolve) {
                return this.select().then(({ error }) => resolve({ error }));
              },
            };
            return chain;
          },
        };
      }
      if (table === "resman_work_orders") {
        return {
          select() {
            return {
              eq(_column, id) {
                return {
                  async maybeSingle() {
                    return { data: workOrders[id] ?? null, error: null };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return db;
}

const fakeClient = { ensureAuthenticated: async () => {} };

function params(db, overrides = {}) {
  return {
    client: fakeClient,
    supabase: db,
    propertyId: "489f05ba-6bd4-4888-9460-88923577a6eb",
    now: NOW,
    log: () => {},
    fetchEmployees: async () => [
      { name: "Allan Zelaya", personId: "55e3d0ac-69e5-434b-b6fe-23fce4131ffb" },
    ],
    ...overrides,
  };
}

const mirrorRow = { resman_unit_id: "a478dccd-7823-463d-8df4-a2adacb573c1" };

test("flush: applies a queued close and stamps the row applied", async () => {
  const db = makeDb({
    queue: [{ resman_work_order_id: WO_A }],
    workOrders: { [WO_A]: mirrorRow },
  });
  const applied = [];
  const result = await flushWorkOrderWrites(
    params(db, {
      applyWrite: async ({ request }) => {
        applied.push(request);
        return { ok: true, phase: "verified", noop: false, detail: "verified" };
      },
    }),
  );
  assert.deepEqual(result, { queued: 1, applied: 1, requeued: 0, failed: 0, unconfirmed: 0 });
  assert.equal(db.rows[0].status, "applied");
  assert.equal(db.rows[0].attempts, 1);
  assert.ok(db.rows[0].applied_at);
  // The close uses the row's created_at as the completion instant.
  assert.equal(applied[0].patch.completedAt, "2026-08-26T19:00:00Z");
  assert.equal(applied[0].expectedUnitId, mirrorRow.resman_unit_id);
});

test("flush: a refused write fails permanently — retrying cannot help", async () => {
  const db = makeDb({
    queue: [{ resman_work_order_id: WO_A }],
    workOrders: { [WO_A]: mirrorRow },
  });
  const result = await flushWorkOrderWrites(
    params(db, {
      applyWrite: async () => {
        throw new WorkOrderWriteRefused("work order is Cancelled — the writer never touches those");
      },
    }),
  );
  assert.equal(result.failed, 1);
  assert.equal(db.rows[0].status, "failed");
  assert.match(db.rows[0].last_error, /Cancelled/);
});

test("flush: transport failure before the POST re-queues until attempts run out", async () => {
  const db = makeDb({
    queue: [{ resman_work_order_id: WO_A, attempts: 0 }],
    workOrders: { [WO_A]: mirrorRow },
  });
  const failing = params(db, {
    applyWrite: async () => {
      throw ResManScrapingError.networkError(new Error("socket hangup"));
    },
  });
  for (let attempt = 1; attempt < WRITE_MAX_ATTEMPTS; attempt += 1) {
    const result = await flushWorkOrderWrites(failing);
    assert.equal(result.requeued, 1, `attempt ${attempt} requeues`);
    assert.equal(db.rows[0].status, "queued");
  }
  const last = await flushWorkOrderWrites(failing);
  assert.equal(last.failed, 1);
  assert.equal(db.rows[0].status, "failed");
  assert.equal(db.rows[0].attempts, WRITE_MAX_ATTEMPTS);
});

test("flush: an unconfirmed POST stays in applying and is NEVER blind re-POSTed", async () => {
  const db = makeDb({
    queue: [{ resman_work_order_id: WO_A }],
    workOrders: { [WO_A]: mirrorRow },
  });
  let posts = 0;
  const result = await flushWorkOrderWrites(
    params(db, {
      applyWrite: async () => {
        posts += 1;
        return { ok: false, phase: "posted", noop: false, detail: "verify read failed after POST" };
      },
    }),
  );
  assert.equal(result.unconfirmed, 1);
  assert.equal(db.rows[0].status, "applying");

  // Second run, still fresh (not yet stale): the row must NOT be touched.
  const again = await flushWorkOrderWrites(
    params(db, {
      applyWrite: async () => {
        posts += 1;
        return { ok: true, phase: "verified", noop: false, detail: "" };
      },
    }),
  );
  assert.equal(posts, 1, "no second POST while the applying row is fresh");
  assert.equal(again.queued, 0);
});

test("flush: a stale applying row is reconciled by VERIFY only", async () => {
  const db = makeDb({
    queue: [
      {
        resman_work_order_id: WO_A,
        status: "applying",
        attempts: 1,
        updated_at: "2026-08-26T19:00:00Z", // 60min old > 10min stale window
      },
    ],
    workOrders: { [WO_A]: mirrorRow },
  });
  let applies = 0;
  let verifies = 0;
  const result = await flushWorkOrderWrites(
    params(db, {
      applyWrite: async () => {
        applies += 1;
        throw new Error("must not apply");
      },
      verifyWrite: async () => {
        verifies += 1;
        return { ok: true, phase: "verified", noop: true, detail: "already applied" };
      },
    }),
  );
  assert.equal(applies, 0);
  assert.equal(verifies, 1);
  assert.equal(result.applied, 1);
  assert.equal(db.rows[0].status, "applied");
});

test("flush: stale applying whose save never landed goes back to queued", async () => {
  const db = makeDb({
    queue: [
      {
        resman_work_order_id: WO_A,
        status: "applying",
        attempts: 1,
        updated_at: "2026-08-26T19:00:00Z",
      },
    ],
    workOrders: { [WO_A]: mirrorRow },
  });
  const result = await flushWorkOrderWrites(
    params(db, {
      verifyWrite: async () => ({ ok: false, phase: "verified", noop: false, detail: "targets not present on re-read" }),
    }),
  );
  assert.equal(result.requeued, 1);
  assert.equal(db.rows[0].status, "queued");
});

test("flush: a reconcile whose verify read errors STAYS in applying (never queued)", async () => {
  // queued would re-POST a save that may have landed — the one-way door.
  const db = makeDb({
    queue: [
      {
        resman_work_order_id: WO_A,
        status: "applying",
        attempts: 1,
        updated_at: "2026-08-26T19:00:00Z",
      },
    ],
    workOrders: { [WO_A]: mirrorRow },
  });
  const result = await flushWorkOrderWrites(
    params(db, {
      verifyWrite: async () => {
        throw ResManScrapingError.networkError(new Error("timeout"));
      },
    }),
  );
  assert.equal(result.unconfirmed, 1);
  assert.equal(db.rows[0].status, "applying");
  assert.match(db.rows[0].last_error, /timeout/);
});

test("flush: a work order missing from the mirror fails cleanly", async () => {
  const db = makeDb({ queue: [{ resman_work_order_id: WO_A }] });
  const result = await flushWorkOrderWrites(params(db));
  assert.equal(result.failed, 1);
  assert.match(db.rows[0].last_error, /not in the mirror/);
});

test("flush: an unresolvable technician fails that row only", async () => {
  const db = makeDb({
    queue: [
      { resman_work_order_id: WO_A, kind: "edit", patch: { technician: "Nobody Real" } },
      { resman_work_order_id: WO_A, kind: "close", patch: {} },
    ],
    workOrders: { [WO_A]: mirrorRow },
  });
  const result = await flushWorkOrderWrites(
    params(db, {
      applyWrite: async () => ({ ok: true, phase: "verified", noop: false, detail: "verified" }),
    }),
  );
  assert.equal(result.failed, 1);
  assert.equal(result.applied, 1);
  assert.match(db.rows[0].last_error, /no maintenance employee/);
  assert.equal(db.rows[1].status, "applied");
});

test("flush: a session death mid-run requeues the row and stops the run", async () => {
  const db = makeDb({
    queue: [
      { resman_work_order_id: WO_A },
      { resman_work_order_id: WO_A, kind: "edit", patch: { description: "x" } },
    ],
    workOrders: { [WO_A]: mirrorRow },
  });
  let calls = 0;
  const result = await flushWorkOrderWrites(
    params(db, {
      applyWrite: async () => {
        calls += 1;
        throw ResManScrapingError.authenticationRequired();
      },
    }),
  );
  assert.equal(calls, 1, "run stopped after the first auth failure");
  assert.equal(result.requeued, 1);
  assert.equal(db.rows[0].status, "queued");
  assert.equal(db.rows[1].status, "queued", "second row untouched");
});

test("flush: technician resolution maps display name to the person GUID", async () => {
  const db = makeDb({
    queue: [{ resman_work_order_id: WO_A, kind: "edit", patch: { technician: "allan zelaya" } }],
    workOrders: { [WO_A]: mirrorRow },
  });
  const seen = [];
  await flushWorkOrderWrites(
    params(db, {
      applyWrite: async ({ request }) => {
        seen.push(request.patch);
        return { ok: true, phase: "verified", noop: false, detail: "verified" };
      },
    }),
  );
  assert.equal(seen[0].technicianPersonId, "55e3d0ac-69e5-434b-b6fe-23fce4131ffb");
});

test("flush: an empty queue makes no ResMan traffic at all", async () => {
  const db = makeDb();
  let authed = false;
  const result = await flushWorkOrderWrites(
    params(db, {
      client: {
        ensureAuthenticated: async () => {
          authed = true;
        },
      },
    }),
  );
  assert.deepEqual(result, { queued: 0, applied: 0, requeued: 0, failed: 0, unconfirmed: 0 });
  assert.equal(authed, false);
});
