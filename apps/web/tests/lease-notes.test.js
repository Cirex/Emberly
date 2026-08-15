const assert = require("node:assert/strict");
const test = require("node:test");
const { mock } = require("bun:test");
const { NextResponse } = require("next/server");
const { tokenForbiddenForResource } = require("../lib/app-role-capabilities");

/**
 * The lease notes thread — /api/resman/manager/lease-notes.
 *
 * Same harness as tests/manager-api.test.js: authentication is stubbed but the
 * allow/deny decision runs the real capability policy, so the route being
 * wired to `manager:leases` (and not a new capability that would sign every
 * existing manager token out) is pinned here.
 */

const state = { auth: { ok: false, response: null }, db: null };

mock.module("@/lib/resman-api-auth", () => ({
  requireStaffToken: async (_request, capability) => {
    if (!state.auth.ok) return state.auth;
    if (state.auth.kind === "scanner" || tokenForbiddenForResource(state.auth.subject, capability)) {
      return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
    return state.auth;
  },
}));

mock.module("@/lib/supabase/admin", () => ({
  createAdminClient: () => state.db,
  createUntypedAdminClient: () => state.db,
  getMissingSupabaseAdminEnvVars: () => [],
}));

const { leaseNoteActor } = require("../lib/lease-notes");
const notesRoute = require("../app/api/resman/manager/lease-notes/route.ts");

function tokenAuth(overrides = {}) {
  return {
    ok: true,
    kind: "token",
    subject: {
      tokenId: "token-1",
      kind: "api_resman",
      subjectType: "admin_user",
      subjectId: "admin-7",
      label: "Eric Parker",
      role: "property_manager",
      scopes: [],
      ...overrides,
    },
  };
}

/** Scripted lease_notes table: records inserts, serves a canned list. */
function notesDb(rows = []) {
  const calls = { inserted: null, filters: {} };
  const db = {
    from(table) {
      assert.equal(table, "lease_notes");
      const chain = {
        select: () => chain,
        eq: (col, val) => ((calls.filters[col] = val), chain),
        is: (col, val) => ((calls.filters[`is:${col}`] = val), chain),
        order: (col, opts) => {
          calls.filters.order = { col, ascending: opts.ascending };
          return Promise.resolve({ data: rows, error: null });
        },
        insert: (row) => {
          calls.inserted = row;
          return {
            select: () => ({
              single: async () => ({
                data: { id: "note-1", created_at: "2026-08-14T00:00:00Z", ...row },
                error: null,
              }),
            }),
          };
        },
      };
      return chain;
    },
  };
  return { db, calls };
}

function getReq(qs) {
  return new Request(`https://x.test/api/resman/manager/lease-notes${qs}`);
}
function postReq(body) {
  return new Request("https://x.test/api/resman/manager/lease-notes", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

test("the thread rides on manager:leases — a maintenance token is refused", async () => {
  state.auth = tokenAuth({ role: "security_manager" });
  state.db = null; // any DB touch would throw
  assert.equal((await notesRoute.GET(getReq("?lease=118-1"))).status, 403);
  assert.equal((await notesRoute.POST(postReq({ resmanLeaseId: "118-1", body: "x" }))).status, 403);
});

test("a property_manager token reads the thread oldest-first, scoped to the lease", async () => {
  state.auth = tokenAuth();
  const { db, calls } = notesDb([
    {
      id: "n1", resman_lease_id: "118-44821", unit_number: "3735 CC-8",
      body: "Waiting on landlord confirmation.", created_by: "Eric Parker",
      created_by_role: "property_manager", created_at: "2026-08-11T19:40:00Z",
    },
  ]);
  state.db = db;

  const res = await notesRoute.GET(getReq("?lease=118-44821"));
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.length, 1);
  assert.equal(data[0].createdBy, "Eric Parker");
  assert.equal(data[0].createdByRole, "property_manager");
  assert.equal(calls.filters.resman_lease_id, "118-44821");
  assert.equal(calls.filters["is:deleted_at"], null);
  // A thread reads downward: oldest first, unlike the action timelines.
  assert.deepEqual(calls.filters.order, { col: "created_at", ascending: true });
});

test("GET without a lease id is a 400, not a whole-table read", async () => {
  state.auth = tokenAuth();
  state.db = null;
  assert.equal((await notesRoute.GET(getReq(""))).status, 400);
});

test("POST stamps the token's name, role, and admin id on the note", async () => {
  state.auth = tokenAuth();
  const { db, calls } = notesDb();
  state.db = db;

  const res = await notesRoute.POST(
    postReq({ resmanLeaseId: "118-44821", unitNumber: "3735 CC-8", body: "Carpet lands Thursday." }),
  );
  assert.equal(res.status, 201);
  assert.equal(calls.inserted.created_by, "Eric Parker");
  assert.equal(calls.inserted.created_by_role, "property_manager");
  assert.equal(calls.inserted.created_by_admin_id, "admin-7");
  assert.equal(calls.inserted.body, "Carpet lands Thursday.");
  const { data } = await res.json();
  assert.equal(data.id, "note-1");
});

test("POST rejects an empty body and an over-long note", async () => {
  state.auth = tokenAuth();
  state.db = null;
  assert.equal((await notesRoute.POST(postReq({ resmanLeaseId: "118-1", body: "  " }))).status, 400);
  assert.equal(
    (await notesRoute.POST(postReq({ resmanLeaseId: "118-1", body: "x".repeat(4001) }))).status,
    400,
  );
});

test("leaseNoteActor blanks the admin id for non-admin subjects", () => {
  const actor = leaseNoteActor(tokenAuth({ subjectType: "service", subjectId: "svc-1" }));
  assert.equal(actor.createdBy, "Eric Parker");
  assert.equal(actor.createdByAdminId, "");
});
