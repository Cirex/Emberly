const assert = require("node:assert/strict");
const test = require("node:test");
const { mock } = require("bun:test");
const { NextResponse } = require("next/server");
const { tokenForbiddenForResource } = require("../lib/app-role-capabilities");

// Same bun:test mock.module harness as tests/manager-api.test.js — this suite
// runs in its own process (the package.json `test` script runs each file
// separately), so the process-global mocks cannot leak into other files.
const state = {
  /** What requireResmanApiKey answers. */
  auth: { ok: false, response: null },
  /** Scripted untyped Supabase client. */
  db: null,
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

mock.module("@/lib/supabase/admin", () => ({
  createAdminClient: () => state.db,
  createUntypedAdminClient: () => state.db,
  getMissingSupabaseAdminEnvVars: () => [],
}));

const {
  bestPolicy,
  insuranceActionActor,
  insuranceActionPayload,
  insurancePolicyPayload,
  listInsurancePolicies,
  maskPolicyNumber,
} = require("../lib/manager-insurance");

const boardRoute = require("../app/api/resman/manager/insurance/route.ts");
const actionsRoute = require("../app/api/resman/manager/insurance-actions/route.ts");
const actionIdRoute = require("../app/api/resman/manager/insurance-actions/[id]/route.ts");

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
      label: "Priya Manager",
      role: "staff",
      scopes: [],
      ...overrides,
    },
  };
}

function untouchableDb() {
  return {
    from() {
      throw new Error("Supabase must not be touched");
    },
  };
}

/**
 * Scripted untyped Supabase: each `from()` consumes the next script
 * ({ table, <action>: result }); every chain method records onto the
 * operation and returns the chain; awaiting the chain (or maybeSingle/single)
 * resolves the scripted result.
 */
function scriptedSupabase(scripts, operations = []) {
  return {
    from(table) {
      const script = scripts.shift();
      if (!script) throw new Error(`Unexpected Supabase table ${table}`);
      assert.equal(table, script.table);
      const start = (action, extra) => {
        const result = script[action];
        if (result === undefined) throw new Error(`No scripted ${action} for ${table}`);
        const operation = { table, action, filters: [], orderBy: [], ...extra };
        operations.push(operation);
        return chain(result, operation);
      };
      return {
        select: (columns) => start("select", { columns }),
        insert: (values) => start("insert", { values }),
        update: (values) => start("update", { values }),
      };
    },
  };
}

function chain(result, operation) {
  const q = {
    eq(column, value) {
      operation.filters.push([column, value]);
      return q;
    },
    is(column, value) {
      operation.filters.push([`is:${column}`, value]);
      return q;
    },
    order(column, options) {
      operation.orderBy.push([column, options]);
      return q;
    },
    range(from, to) {
      operation.range = [from, to];
      return q;
    },
    select(columns) {
      operation.selectColumns = columns;
      return q;
    },
    maybeSingle: async () => result,
    single: async () => result,
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return q;
}

function managerRequest(path, init) {
  return new Request(`https://emberly-web.test/api/resman/manager${path}`, init);
}

function jsonPost(path, body) {
  return managerRequest(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ACTION_ID = "0f9b2a58-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const actionParams = { params: Promise.resolve({ id: ACTION_ID }) };

// --- pure helpers ---------------------------------------------------------

test("maskPolicyNumber keeps only the last four characters", () => {
  assert.equal(maskPolicyNumber("POL-884471"), "4471");
  assert.equal(maskPolicyNumber("  8820 "), "8820");
  assert.equal(maskPolicyNumber("99"), "99");
  assert.equal(maskPolicyNumber(""), "");
  assert.equal(maskPolicyNumber(null), "");
  assert.equal(maskPolicyNumber(undefined), "");
});

test("bestPolicy picks the latest end_date; dated rows beat undated", () => {
  const older = { resman_insurance_id: "i-1", end_date: "2025-04-02" };
  const newer = { resman_insurance_id: "i-2", end_date: "2026-04-02" };
  const undated = { resman_insurance_id: "i-3", end_date: null };
  assert.equal(bestPolicy([]), null);
  assert.equal(bestPolicy([older, newer, undated]), newer);
  assert.equal(bestPolicy([undated, older]), older);
  // All-undated: the first row wins (stable), and it still counts as filed.
  assert.equal(bestPolicy([undated, { resman_insurance_id: "i-4", end_date: null }]), undated);
});

test("insurancePolicyPayload masks the number and nulls policy fields when never filed", () => {
  const lease = {
    resman_lease_id: "l-1",
    resman_unit_id: "u-1",
    unit_number: "0731",
    start_date: "2025-03-15",
    move_in_date: "2025-04-01",
  };
  const filed = insurancePolicyPayload(
    lease,
    {
      resman_insurance_id: "i-1",
      resman_person_lease_id: "pl-1",
      provider: "Allstate",
      policy_number: "POL-778820",
      policy_type: "Renters liability",
      start_date: "2025-04-02",
      end_date: "2026-04-02",
      coverage_amount: 100000,
    },
    ["Marcus Sanders"],
  );
  assert.deepEqual(filed, {
    leaseId: "l-1",
    unitNumber: "0731",
    tenantNames: ["Marcus Sanders"],
    leaseStart: "2025-04-01",
    policyId: "i-1",
    provider: "Allstate",
    policyNumberLast4: "8820",
    policyType: "Renters liability",
    coverageAmount: 100000,
    startDate: "2025-04-02",
    endDate: "2026-04-02",
  });
  assert.equal("policyNumber" in filed, false, "the full number must never reach the wire");

  const neverFiled = insurancePolicyPayload(lease, null, []);
  assert.equal(neverFiled.policyId, null);
  assert.equal(neverFiled.provider, null);
  assert.equal(neverFiled.policyNumberLast4, null);
  assert.equal(neverFiled.policyType, null);
  assert.equal(neverFiled.coverageAmount, null);
  assert.equal(neverFiled.startDate, null);
  assert.equal(neverFiled.endDate, null);
  // move_in_date missing → start_date carries the never-filed context.
  const noMoveIn = insurancePolicyPayload({ ...lease, move_in_date: null }, null, []);
  assert.equal(noMoveIn.leaseStart, "2025-03-15");
});

test("insuranceActionActor records the token label and admin id", () => {
  const actor = insuranceActionActor(tokenAuth());
  assert.deepEqual(actor, { createdBy: "Priya Manager", createdByAdminId: "admin-7" });
  const nonAdmin = insuranceActionActor(tokenAuth({ subjectType: "scanner_device" }));
  assert.equal(nonAdmin.createdByAdminId, "");
  assert.deepEqual(insuranceActionActor({ kind: "scanner" }), {
    createdBy: "scanner",
    createdByAdminId: "",
  });
});

test("insuranceActionPayload camelCases the row", () => {
  assert.deepEqual(
    insuranceActionPayload({
      id: ACTION_ID,
      resman_lease_id: "l-1",
      unit_number: "0731",
      kind: "proof_requested",
      note: "email + portal",
      created_by: "B. Bloch",
      created_at: "2026-07-08T14:00:00Z",
    }),
    {
      id: ACTION_ID,
      resmanLeaseId: "l-1",
      unitNumber: "0731",
      kind: "proof_requested",
      note: "email + portal",
      createdBy: "B. Bloch",
      createdAt: "2026-07-08T14:00:00Z",
    },
  );
});

// --- listInsurancePolicies join -------------------------------------------

test("listInsurancePolicies joins current leases, best policy, and tenant names", async () => {
  const operations = [];
  const db = scriptedSupabase(
    [
      {
        table: "resman_leases",
        select: {
          data: [
            {
              resman_lease_id: "l-1",
              resman_unit_id: "u-1",
              unit_number: "0731",
              start_date: "2025-03-15",
              move_in_date: "2025-04-01",
            },
            {
              resman_lease_id: "l-2",
              resman_unit_id: null,
              unit_number: "0919",
              start_date: "2025-03-01",
              move_in_date: null,
            },
          ],
          error: null,
        },
      },
      {
        table: "resman_residents",
        select: {
          data: [
            { resman_person_lease_id: "pl-1", resman_lease_id: "l-1" },
            { resman_person_lease_id: "pl-2", resman_lease_id: "l-1" },
            { resman_person_lease_id: "pl-9", resman_lease_id: "l-gone" },
          ],
          error: null,
        },
      },
      {
        table: "resman_lease_insurance",
        select: {
          data: [
            {
              resman_insurance_id: "i-old",
              resman_person_lease_id: "pl-1",
              provider: "Progressive",
              policy_number: "111199",
              policy_type: "Renters",
              start_date: "2024-04-02",
              end_date: "2025-04-02",
              coverage_amount: 50000,
            },
            {
              resman_insurance_id: "i-new",
              resman_person_lease_id: "pl-2",
              provider: "Allstate",
              policy_number: "POL-778820",
              policy_type: "Renters liability",
              start_date: "2025-04-02",
              end_date: "2026-04-02",
              coverage_amount: 100000,
            },
            {
              // Orphan policy (its resident is not on a current lease): dropped.
              resman_insurance_id: "i-orphan",
              resman_person_lease_id: "pl-unknown",
              provider: "Lemonade",
              policy_number: "9930",
              policy_type: "Renters",
              start_date: null,
              end_date: "2026-08-08",
              coverage_amount: 50000,
            },
          ],
          error: null,
        },
      },
      {
        table: "resman_units",
        select: {
          data: [
            { resman_unit_id: "u-1", number: "0731", tenant_names: ["Marcus Sanders"] },
            { resman_unit_id: "u-2", number: "0919", tenant_names: ["Asha Patel"] },
          ],
          error: null,
        },
      },
    ],
    operations,
  );

  const policies = await listInsurancePolicies(db);
  assert.equal(policies.length, 2);

  const [sanders, patel] = policies; // sorted by unit number: 0731, 0919
  assert.equal(sanders.leaseId, "l-1");
  assert.equal(sanders.provider, "Allstate", "the LATEST end_date across residents wins");
  assert.equal(sanders.policyNumberLast4, "8820");
  assert.equal(sanders.endDate, "2026-04-02");
  assert.deepEqual(sanders.tenantNames, ["Marcus Sanders"]);

  // l-2 has no residents/policies → NEVER FILED, tenant names via unit number.
  assert.equal(patel.leaseId, "l-2");
  assert.equal(patel.policyId, null);
  assert.equal(patel.provider, null);
  assert.deepEqual(patel.tenantNames, ["Asha Patel"]);
  assert.equal(patel.leaseStart, "2025-03-01");

  // The lease read filters to current leases only.
  const leaseOp = operations.find((op) => op.table === "resman_leases");
  assert.deepEqual(leaseOp.filters, [["is_current_lease", true]]);
});

// --- GET /manager/insurance ------------------------------------------------

test("GET insurance rejects failed auth without touching Supabase", async () => {
  state.auth = { ok: false, response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }) };
  state.db = untouchableDb();
  const response = await boardRoute.GET(managerRequest("/insurance"));
  assert.equal(response.status, 401);
});

test("GET insurance answers 403 for scanner callers", async () => {
  state.auth = { ok: true, kind: "scanner" };
  state.db = untouchableDb();
  const response = await boardRoute.GET(managerRequest("/insurance"));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Forbidden");
});

test("GET insurance returns { policies, actions } with masked numbers", async () => {
  state.auth = tokenAuth();
  state.db = scriptedSupabase([
    {
      table: "resman_leases",
      select: {
        data: [
          {
            resman_lease_id: "l-1",
            resman_unit_id: "u-1",
            unit_number: "0731",
            start_date: "2025-03-15",
            move_in_date: "2025-04-01",
          },
        ],
        error: null,
      },
    },
    {
      table: "resman_residents",
      select: { data: [{ resman_person_lease_id: "pl-1", resman_lease_id: "l-1" }], error: null },
    },
    {
      table: "resman_lease_insurance",
      select: {
        data: [
          {
            resman_insurance_id: "i-1",
            resman_person_lease_id: "pl-1",
            provider: "Allstate",
            policy_number: "POL-778820",
            policy_type: "Renters liability",
            start_date: "2025-04-02",
            end_date: "2026-04-02",
            coverage_amount: 100000,
          },
        ],
        error: null,
      },
    },
    {
      table: "resman_units",
      select: {
        data: [{ resman_unit_id: "u-1", number: "0731", tenant_names: ["Marcus Sanders"] }],
        error: null,
      },
    },
    {
      table: "insurance_actions",
      select: {
        data: [
          {
            id: ACTION_ID,
            resman_lease_id: "l-1",
            unit_number: "0731",
            kind: "proof_requested",
            note: "",
            created_by: "B. Bloch",
            created_at: "2026-07-08T14:00:00Z",
          },
        ],
        error: null,
      },
    },
  ]);

  const response = await boardRoute.GET(managerRequest("/insurance"));
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.policies.length, 1);
  assert.equal(data.policies[0].policyNumberLast4, "8820");
  assert.equal(JSON.stringify(data).includes("POL-778820"), false, "full number must not leak");
  assert.equal(data.actions.length, 1);
  assert.equal(data.actions[0].kind, "proof_requested");
  assert.equal(data.actions[0].createdBy, "B. Bloch");
});

// --- POST /manager/insurance-actions ---------------------------------------

test("POST insurance-actions rejects bad payloads with 400", async () => {
  state.auth = tokenAuth();
  state.db = untouchableDb();
  const bad = [
    {},
    { resmanLeaseId: "", kind: "note" },
    { resmanLeaseId: "l-1", kind: "called" }, // a delinquency kind, not ours
    { resmanLeaseId: "l-1", kind: "proof_requested", note: "x".repeat(4001) },
  ];
  for (const body of bad) {
    const response = await actionsRoute.POST(jsonPost("/insurance-actions", body));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error, "Invalid request");
  }
  // A body that is not JSON at all also answers 400.
  const response = await actionsRoute.POST(
    managerRequest("/insurance-actions", { method: "POST" }),
  );
  assert.equal(response.status, 400);
});

test("POST insurance-actions answers 403 for scanner callers", async () => {
  state.auth = { ok: true, kind: "scanner" };
  state.db = untouchableDb();
  const response = await actionsRoute.POST(
    jsonPost("/insurance-actions", { resmanLeaseId: "l-1", kind: "note" }),
  );
  assert.equal(response.status, 403);
});

test("POST insurance-actions stores the action with token attribution", async () => {
  state.auth = tokenAuth();
  const operations = [];
  state.db = scriptedSupabase(
    [
      {
        table: "insurance_actions",
        insert: {
          data: {
            id: ACTION_ID,
            resman_lease_id: "l-1",
            unit_number: "0731",
            kind: "verified",
            note: "carrier confirmed by phone",
            created_by: "Priya Manager",
            created_at: "2026-07-21T15:00:00Z",
          },
          error: null,
        },
      },
    ],
    operations,
  );

  const response = await actionsRoute.POST(
    jsonPost("/insurance-actions", {
      resmanLeaseId: "l-1",
      unitNumber: "0731",
      kind: "verified",
      note: "carrier confirmed by phone",
    }),
  );
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    data: {
      id: ACTION_ID,
      resmanLeaseId: "l-1",
      unitNumber: "0731",
      kind: "verified",
      note: "carrier confirmed by phone",
      createdBy: "Priya Manager",
      createdAt: "2026-07-21T15:00:00Z",
    },
  });
  assert.deepEqual(operations[0].values, {
    resman_lease_id: "l-1",
    unit_number: "0731",
    kind: "verified",
    note: "carrier confirmed by phone",
    created_by: "Priya Manager",
    created_by_admin_id: "admin-7",
  });
});

// --- DELETE /manager/insurance-actions/[id] --------------------------------

test("DELETE insurance-actions answers 404 for malformed and unknown ids", async () => {
  state.auth = tokenAuth();
  state.db = untouchableDb();
  const malformed = await actionIdRoute.DELETE(
    managerRequest("/insurance-actions/not-a-uuid", { method: "DELETE" }),
    { params: Promise.resolve({ id: "not-a-uuid" }) },
  );
  assert.equal(malformed.status, 404);

  state.db = scriptedSupabase([
    { table: "insurance_actions", select: { data: null, error: null } },
  ]);
  const unknown = await actionIdRoute.DELETE(
    managerRequest(`/insurance-actions/${ACTION_ID}`, { method: "DELETE" }),
    actionParams,
  );
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, "Action not found");
});

test("DELETE insurance-actions soft-deletes a live action", async () => {
  state.auth = tokenAuth();
  const operations = [];
  state.db = scriptedSupabase(
    [
      { table: "insurance_actions", select: { data: { id: ACTION_ID }, error: null } },
      { table: "insurance_actions", update: { error: null } },
    ],
    operations,
  );

  const response = await actionIdRoute.DELETE(
    managerRequest(`/insurance-actions/${ACTION_ID}`, { method: "DELETE" }),
    actionParams,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { deleted: true } });
  assert.equal(operations[1].action, "update");
  assert.equal(typeof operations[1].values.deleted_at, "string");
  assert.deepEqual(operations[1].filters, [["id", ACTION_ID]]);
});
