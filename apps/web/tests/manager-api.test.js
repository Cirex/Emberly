const assert = require("node:assert/strict");
const test = require("node:test");
const { mock } = require("bun:test");
const { NextResponse } = require("next/server");
const { tokenForbiddenForResource } = require("../lib/app-role-capabilities");

// Same bun:test mock.module harness as tests/pm-tasks.test.js — this suite
// runs in its own process (the package.json `test` script runs each file
// separately), so the process-global mocks cannot leak into other files. The
// mocks are installed before the lib/routes are required so every consumer
// resolves them.
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

const { delinquencyActionActor } = require("../lib/delinquency-actions");
const { isDelinquentUnit } = require("../lib/manager-delinquency");
const { monthsAgoIsoDate, recentLeaseOrFilter } = require("../lib/manager-leases");
const {
  chargeBucketOf,
  isConcessionEntry,
  isWriteoffEntry,
  summarizeLedgerEntries,
} = require("../lib/manager-ledger");
const { monthKey, monthlyBillTotals, mlgwReviewId } = require("../lib/manager-mlgw");
const { renewalOfferActor } = require("../lib/renewal-offers");

const leasesRoute = require("../app/api/resman/manager/leases/route.ts");
const delinquencyRoute = require("../app/api/resman/manager/delinquency/route.ts");
const actionsRoute = require("../app/api/resman/manager/delinquency-actions/route.ts");
const actionIdRoute = require("../app/api/resman/manager/delinquency-actions/[id]/route.ts");
const ledgerSummaryRoute = require("../app/api/resman/manager/ledger-summary/route.ts");
const ledgerRoute = require("../app/api/resman/manager/ledger/route.ts");
const mlgwRoute = require("../app/api/resman/manager/mlgw/route.ts");
const mlgwReviewsRoute = require("../app/api/resman/manager/mlgw-reviews/route.ts");
const renewalOffersRoute = require("../app/api/resman/manager/renewal-offers/route.ts");
const renewalOfferIdRoute = require("../app/api/resman/manager/renewal-offers/[id]/route.ts");

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
        update: (patch) => start("update", { patch }),
        upsert: (values, options) => start("upsert", { values, upsertOptions: options }),
        delete: () => start("delete", {}),
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
    in(column, values) {
      operation.filters.push([`in:${column}`, values]);
      return q;
    },
    gte(column, value) {
      operation.filters.push([`gte:${column}`, value]);
      return q;
    },
    is(column, value) {
      operation.filters.push([`is:${column}`, value]);
      return q;
    },
    not(column, op, value) {
      operation.filters.push([`not:${column}`, op, value]);
      return q;
    },
    or(expression) {
      operation.filters.push(["or", expression]);
      return q;
    },
    order(column, options) {
      operation.orderBy.push([column, options]);
      return q;
    },
    limit(count) {
      operation.limit = count;
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

const ACTION_ID = "3f0a2b6c-9d1e-4f5a-8b7c-1d2e3f4a5b6c";
const actionIdParams = { params: Promise.resolve({ id: ACTION_ID }) };

const OFFER_ID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const offerIdParams = { params: Promise.resolve({ id: OFFER_ID }) };

function jsonPatch(path, body) {
  return managerRequest(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- pure helpers: attribution & board membership -------------------------

test("delinquencyActionActor attributes the token label and admin id", () => {
  assert.deepEqual(delinquencyActionActor(tokenAuth()), {
    createdBy: "Priya Manager",
    createdByAdminId: "admin-7",
  });
  assert.deepEqual(
    delinquencyActionActor(tokenAuth({ subjectType: "integration", subjectId: "int-1" })),
    { createdBy: "Priya Manager", createdByAdminId: "" },
  );
  assert.deepEqual(delinquencyActionActor({ kind: "scanner" }), {
    createdBy: "scanner",
    createdByAdminId: "",
  });
});

test("renewalOfferActor attributes the token label and admin id", () => {
  assert.deepEqual(renewalOfferActor(tokenAuth()), {
    createdBy: "Priya Manager",
    createdByAdminId: "admin-7",
  });
  assert.deepEqual(
    renewalOfferActor(tokenAuth({ subjectType: "integration", subjectId: "int-1" })),
    { createdBy: "Priya Manager", createdByAdminId: "" },
  );
  assert.deepEqual(renewalOfferActor({ kind: "scanner" }), {
    createdBy: "scanner",
    createdByAdminId: "",
  });
});

test("isDelinquentUnit: positive balance or a non-blank reason", () => {
  assert.equal(isDelinquentUnit({ balance: 120.5, delinquency_reason: "" }), true);
  assert.equal(isDelinquentUnit({ balance: 0, delinquency_reason: "Under eviction" }), true);
  assert.equal(isDelinquentUnit({ balance: null, delinquency_reason: "x" }), true);
  assert.equal(isDelinquentUnit({ balance: 0, delinquency_reason: "  " }), false);
  assert.equal(isDelinquentUnit({ balance: -35, delinquency_reason: null }), false);
  assert.equal(isDelinquentUnit({ balance: null, delinquency_reason: null }), false);
});

test("lease window helpers: 24-month cutoff and the or-filter", () => {
  const now = Date.UTC(2026, 6, 15, 12); // 2026-07-15
  assert.equal(monthsAgoIsoDate(now, 24), "2024-07-15");
  assert.equal(
    recentLeaseOrFilter("2024-07-15"),
    "is_current_lease.eq.true,application_date.gte.2024-07-15," +
      "start_date.gte.2024-07-15,move_in_date.gte.2024-07-15",
  );
});

// --- pure helpers: ledger matchers & aggregation --------------------------

test("concession/write-off matchers scan category and description", () => {
  assert.equal(isConcessionEntry({ category: "Concession", ledger_description: "" }), true);
  assert.equal(isConcessionEntry({ category: "RENT CONCESSION", ledger_description: "" }), true);
  assert.equal(isConcessionEntry({ category: "Rent", ledger_description: "July concession" }), true);
  assert.equal(isConcessionEntry({ category: "Rent", ledger_description: "Rent July" }), false);

  assert.equal(isWriteoffEntry({ category: "Write Off", ledger_description: "" }), true);
  assert.equal(isWriteoffEntry({ category: "Writeoff", ledger_description: "" }), true);
  assert.equal(isWriteoffEntry({ category: "", ledger_description: "Write-off bad debt" }), true);
  assert.equal(isWriteoffEntry({ category: "", ledger_description: "WRITEOFF" }), true);
  assert.equal(isWriteoffEntry({ category: "Rent", ledger_description: "written notice" }), false);
});

function ledgerEntry(overrides = {}) {
  return {
    resman_lease_id: "lease-1",
    date: null,
    category: "Rent",
    ledger_description: "",
    charges: null,
    credits: null,
    balance: null,
    ledger_sequence: null,
    ...overrides,
  };
}

test("summarizeLedgerEntries aggregates one row per lease", () => {
  const entries = [
    // lease-1: late in March (month-end 300), NOT in February — the Feb late
    // fee (seq 3) is cleared by the same-day payment (seq 4), which the
    // sequence sort must place last.
    ledgerEntry({ date: "2026-01-05", ledger_sequence: 0, charges: 800, balance: 800 }),
    ledgerEntry({ date: "2026-01-20", ledger_sequence: 1, credits: 800, balance: 0 }),
    ledgerEntry({ date: "2026-02-01", ledger_sequence: 2, charges: 800, balance: 800 }),
    ledgerEntry({ date: "2026-02-28", ledger_sequence: 4, credits: 850, balance: 0 }),
    ledgerEntry({
      date: "2026-02-28",
      ledger_sequence: 3,
      charges: 50,
      balance: 850,
      category: "Late Fees",
    }),
    ledgerEntry({ date: "2026-03-01", ledger_sequence: 5, charges: 800, balance: 800 }),
    ledgerEntry({ date: "2026-03-25", ledger_sequence: 6, credits: 500, balance: 300 }),
    // lease-2: concession net 150 (200 credit − 50 reversal charge),
    // write-off 550, late from April on.
    ledgerEntry({ resman_lease_id: "lease-2", date: "2026-04-01", ledger_sequence: 0, charges: 700, balance: 700 }),
    ledgerEntry({
      resman_lease_id: "lease-2",
      date: "2026-04-05",
      ledger_sequence: 1,
      credits: 200,
      balance: 500,
      category: "Concession",
    }),
    ledgerEntry({
      resman_lease_id: "lease-2",
      date: "2026-04-06",
      ledger_sequence: 2,
      charges: 50,
      balance: 550,
      category: "Concession",
      ledger_description: "Concession reversal",
    }),
    ledgerEntry({
      resman_lease_id: "lease-2",
      date: "2026-05-30",
      ledger_sequence: 3,
      credits: 550,
      balance: 0,
      category: "Adjustments",
      ledger_description: "Write Off bad debt",
    }),
    // Lease-less rows never leak in.
    ledgerEntry({ resman_lease_id: null, date: "2026-01-01", charges: 999, balance: 999 }),
  ];

  assert.deepEqual(summarizeLedgerEntries(entries), [
    {
      leaseId: "lease-1",
      billed: 2450,
      collected: 2150,
      lastPaymentDate: "2026-03-25",
      firstLateMonth: "2026-03",
      concessions: 0,
      writeoffs: 0,
      legalFiledDate: null,
      legalFees: 0,
      // FIFO leaves only the unpaid March rent charge open.
      composition: { rent: 300, late: 0, utility: 0, legal: 0, insurance: 0, moveout: 0, other: 0 },
      owed: 300,
      credit: 0,
      rentOwed: 300,
    },
    {
      leaseId: "lease-2",
      billed: 750,
      collected: 750,
      lastPaymentDate: "2026-05-30",
      firstLateMonth: "2026-04",
      concessions: 150,
      writeoffs: 550,
      legalFiledDate: null,
      legalFees: 0,
      // The write-off credit drains every open charge; nothing is left owing.
      composition: { rent: 0, late: 0, utility: 0, legal: 0, insurance: 0, moveout: 0, other: 0 },
      owed: 0,
      credit: 0,
      rentOwed: 0,
    },
  ]);
});

test("summarizeLedgerEntries rounds money and stays under the late threshold", () => {
  const [summary] = summarizeLedgerEntries([
    ledgerEntry({ date: "2026-01-01", charges: 100.105, balance: 100.105 }),
    // Month-end balance of 50 is exactly AT the threshold, which is exclusive.
    ledgerEntry({ date: "2026-01-05", credits: 50.100000001, balance: 50 }),
  ]);
  assert.deepEqual(summary, {
    leaseId: "lease-1",
    billed: 100.11,
    collected: 50.1,
    lastPaymentDate: "2026-01-05",
    firstLateMonth: null,
    concessions: 0,
    writeoffs: 0,
    legalFiledDate: null,
    legalFees: 0,
    // 100.105 charged less 50.100000001 paid, rounded: 50.00.
    composition: { rent: 50, late: 0, utility: 0, legal: 0, insurance: 0, moveout: 0, other: 0 },
    owed: 50,
    credit: 0,
    rentOwed: 50,
  });
});

test("summarizeLedgerEntries skips a lease whose rows are all outside the rent ledger", () => {
  // A null running balance is ResMan's marker for the deposit sub-ledger. A
  // lease made only of those has no income statement, and emitting a zeroed
  // summary would hand it a tenant P&L reading "collected 100% of $0".
  assert.deepEqual(
    summarizeLedgerEntries([
      ledgerEntry({ date: "2026-01-01", category: "SECD", charges: 300, balance: null }),
      ledgerEntry({ date: "2026-01-05", category: "SECD", credits: 300, balance: null }),
    ]),
    [],
  );
});

test("chargeBucketOf reads codes first and never files insurance as legal", () => {
  // DMG-WVR is renter's insurance and its label contains the word "Legal".
  assert.equal(chargeBucketOf("DMG-WVR"), "insurance");
  assert.equal(chargeBucketOf("Renters Legal Liability"), "insurance");
  assert.equal(chargeBucketOf("ATTYCH"), "legal");
  assert.equal(chargeBucketOf("Attorney's Fees / Court Fees"), "legal");
  assert.equal(chargeBucketOf("RENTCH"), "rent");
  assert.equal(chargeBucketOf("Rent"), "rent");
  assert.equal(chargeBucketOf("LATECH"), "late");
  assert.equal(chargeBucketOf("Late Fees"), "late");
  assert.equal(chargeBucketOf("Sub Pmt"), "other");
});

test("summarizeLedgerEntries dates the eviction from ATTYCH fees", () => {
  const [summary] = summarizeLedgerEntries([
    // The migration opened this ledger on 2026-02-16 carrying an attorney fee
    // billed long before ResMan. It has no filing date we can trust, so the
    // whole opening day is excluded.
    ledgerEntry({ date: "2026-02-16", charges: 2345, balance: 2345 }),
    ledgerEntry({ date: "2026-02-16", charges: 180, category: "ATTYCH", ledger_description: "Attorney's Fees / Court Fees Charge" }),
    // Renter's insurance says "Legal" and must never read as a filing.
    ledgerEntry({ date: "2026-02-20", charges: 19, category: "DMG-WVR", ledger_description: "Renters Legal Liability Charge" }),
    // The real filing, then service of process three weeks later.
    ledgerEntry({ date: "2026-03-04", charges: 235, category: "ATTYCH", ledger_description: "Attorney's Fees / Court Fees Charge" }),
    ledgerEntry({ date: "2026-03-25", charges: 45, category: "ATTYCH", ledger_description: "PROCESS SERVER" }),
    // Negative rows are the reversal half of a pair; the positive original is
    // still counted above, because the filing did happen.
    ledgerEntry({ date: "2026-04-02", charges: -45, category: "ATTYCH", ledger_description: "Reversed to collections PROCESS SERVER" }),
  ]);
  assert.equal(summary.legalFiledDate, "2026-03-04");
  assert.equal(summary.legalFees, 280);
});

test("summarizeLedgerEntries reports no filing when ATTYCH only lands on the opening day", () => {
  const [summary] = summarizeLedgerEntries([
    ledgerEntry({ date: "2026-02-16", charges: 900, balance: 900 }),
    ledgerEntry({ date: "2026-02-16", charges: 235, category: "ATTYCH", ledger_description: "Attorney's Fees / Court Fees Charge" }),
    ledgerEntry({ date: "2026-03-01", charges: 800, balance: 1935 }),
  ]);
  assert.equal(summary.legalFiledDate, null);
  assert.equal(summary.legalFees, 0);
});

// --- pure helpers: MLGW monthly totals ------------------------------------

test("monthlyBillTotals buckets the trailing 12 months, ascending", () => {
  const now = Date.UTC(2026, 6, 15); // 2026-07-15 → window floor 2025-08
  assert.equal(monthKey(now, 0), "2026-07");
  assert.equal(monthKey(now, 11), "2025-08");

  const rows = [
    { bill_date: "2025-07-20", amount_due: 999 }, // before the window
    { bill_date: "2025-08-05", amount_due: 100 },
    { bill_date: "2025-08-25", amount_due: 50.505 },
    { bill_date: "2026-07-01", amount_due: 200 },
    { bill_date: null, amount_due: 77 }, // undated bills are skipped
  ];
  assert.deepEqual(monthlyBillTotals(rows, now), [
    { month: "2025-08", total: 150.51, billCount: 2 },
    { month: "2026-07", total: 200, billCount: 1 },
  ]);
});

test("mlgwReviewId is the sync's natural key", () => {
  assert.equal(mlgwReviewId("prop-1", "bill-9", "missing_bill"), "prop-1|bill-9|missing_bill");
});

// --- auth gating ----------------------------------------------------------

function allRouteAttempts() {
  return [
    () => leasesRoute.GET(managerRequest("/leases")),
    () => delinquencyRoute.GET(managerRequest("/delinquency")),
    () => actionsRoute.POST(jsonPost("/delinquency-actions", { resmanLeaseId: "l", kind: "note" })),
    () =>
      actionIdRoute.DELETE(
        managerRequest(`/delinquency-actions/${ACTION_ID}`, { method: "DELETE" }),
        actionIdParams,
      ),
    () => ledgerSummaryRoute.GET(managerRequest("/ledger-summary")),
    () => ledgerRoute.GET(managerRequest("/ledger?leaseId=lease-1")),
    () => mlgwRoute.GET(managerRequest("/mlgw")),
    () =>
      mlgwReviewsRoute.POST(
        jsonPost("/mlgw-reviews", { billId: "b", exceptionKind: "k", reviewed: true }),
      ),
    () => renewalOffersRoute.GET(managerRequest("/renewal-offers")),
    () =>
      renewalOffersRoute.POST(
        jsonPost("/renewal-offers", { resmanLeaseId: "l", proposedRent: 1200 }),
      ),
    () =>
      renewalOfferIdRoute.PATCH(
        jsonPatch(`/renewal-offers/${OFFER_ID}`, { status: "accepted" }),
        offerIdParams,
      ),
  ];
}

test("unauthenticated requests get 401 on every route and never touch the DB", async () => {
  state.db = untouchableDb();
  for (const attempt of allRouteAttempts()) {
    // A fresh response per attempt — a NextResponse body reads once.
    state.auth = {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
    const response = await attempt();
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "Unauthorized");
  }
});

test("scanner credentials are refused everywhere: manager data is staff-only", async () => {
  state.auth = { ok: true, kind: "scanner" };
  state.db = untouchableDb();
  for (const attempt of allRouteAttempts()) {
    const response = await attempt();
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "Forbidden");
  }
});

// --- GET /manager/leases --------------------------------------------------

function leaseRow(overrides = {}) {
  return {
    resman_lease_id: "lease-1",
    resman_unit_id: "unit-1",
    unit_number: "1809 BA-1",
    status: "Current",
    approval_status: "Approved",
    application_date: "2026-05-01",
    signed_date: "2026-05-10",
    start_date: "2026-06-01",
    end_date: "2027-05-31",
    move_in_date: "2026-06-01",
    move_out_date: null,
    leasing_agent: "Dana Agent",
    market_rent: 1200,
    resident_rent: 1150,
    balance: 0,
    is_current_lease: true,
    is_most_recent_lease: true,
    ...overrides,
  };
}

test("GET leases returns the 24-month window as camelCase DTOs", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [{ table: "resman_leases", select: { data: [leaseRow()], error: null } }],
    operations,
  );

  const response = await leasesRoute.GET(managerRequest("/leases"));
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(data.leases, [
    {
      id: "lease-1",
      unitId: "unit-1",
      unitNumber: "1809 BA-1",
      status: "Current",
      approvalStatus: "Approved",
      applicationDate: "2026-05-01",
      signedDate: "2026-05-10",
      startDate: "2026-06-01",
      startDateChanges: 0,
      endDate: "2027-05-31",
      moveInDate: "2026-06-01",
      moveOutDate: null,
      reasonForLeaving: "",
      leasingAgent: "Dana Agent",
      marketRent: 1200,
      residentRent: 1150,
      balance: 0,
      isCurrentLease: true,
      isMostRecentLease: true,
    },
  ]);

  const [op] = operations;
  assert.deepEqual(op.filters, [["or", recentLeaseOrFilter(monthsAgoIsoDate(Date.now(), 24))]]);
  // start_date is NOT unique, and the read is paged. Offset paging over a
  // non-total order can drop a row from one page and repeat it on the next, so
  // the lease id rides along as a tiebreak to make the sort total.
  assert.deepEqual(op.orderBy, [
    ["start_date", { ascending: false }],
    ["resman_lease_id", { ascending: true }],
  ]);
});

// --- GET /manager/delinquency ---------------------------------------------

function unitRow(overrides = {}) {
  return {
    resman_unit_id: "unit-1",
    number: "1809 BA-1",
    tenant_names: ["Jordan Rivers"],
    balance: 420.75,
    current_month_balance: 300,
    last_month_balance: 120.75,
    period_balance: 420.75,
    previous_balance: 0,
    times_late: 3,
    delinquency_reason: "",
    leasing_agent: "Dana Agent",
    current_lease_id: "lease-1",
    market_rent: 1200,
    ...overrides,
  };
}

test("GET delinquency returns owing units plus their live action timeline", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [
      {
        table: "resman_units",
        select: {
          data: [
            unitRow(),
            unitRow({
              resman_unit_id: "unit-2",
              number: "1809 BA-2",
              balance: 0,
              delinquency_reason: "Under eviction",
              times_late: null,
              current_lease_id: null,
              leasing_agent: null,
            }),
            unitRow({ resman_unit_id: "unit-3", number: "1809 BA-3", balance: 0, delinquency_reason: null }),
          ],
          error: null,
        },
      },
      {
        table: "delinquency_actions",
        select: {
          data: [
            {
              id: ACTION_ID,
              resman_lease_id: "lease-1",
              resman_unit_id: "unit-1",
              unit_number: "1809 BA-1",
              kind: "called",
              note: "Left voicemail",
              amount: null,
              promise_due_date: null,
              created_by: "Priya Manager",
              created_at: "2026-07-18T15:00:00.000Z",
            },
          ],
          error: null,
        },
      },
    ],
    operations,
  );

  const response = await delinquencyRoute.GET(managerRequest("/delinquency"));
  assert.equal(response.status, 200);
  const { data } = await response.json();

  // The clean unit-3 is filtered out; DTOs are camelCase.
  assert.deepEqual(data.units, [
    {
      unitId: "unit-1",
      unitNumber: "1809 BA-1",
      tenantNames: ["Jordan Rivers"],
      balance: 420.75,
      currentMonthBalance: 300,
      lastMonthBalance: 120.75,
      periodBalance: 420.75,
      previousBalance: 0,
      timesLate: 3,
      delinquencyReason: "",
      leasingAgent: "Dana Agent",
      currentLeaseId: "lease-1",
      marketRent: 1200,
    },
    {
      unitId: "unit-2",
      unitNumber: "1809 BA-2",
      tenantNames: ["Jordan Rivers"],
      balance: 0,
      currentMonthBalance: 300,
      lastMonthBalance: 120.75,
      periodBalance: 420.75,
      previousBalance: 0,
      timesLate: null,
      delinquencyReason: "Under eviction",
      leasingAgent: "",
      currentLeaseId: null,
      marketRent: 1200,
    },
  ]);
  assert.deepEqual(data.actions, [
    {
      id: ACTION_ID,
      resmanLeaseId: "lease-1",
      resmanUnitId: "unit-1",
      unitNumber: "1809 BA-1",
      kind: "called",
      note: "Left voicemail",
      amount: null,
      promiseDueDate: null,
      createdBy: "Priya Manager",
      createdAt: "2026-07-18T15:00:00.000Z",
    },
  ]);

  // Actions are narrowed to the delinquent units, live only, newest first.
  const actionsOp = operations[1];
  assert.deepEqual(actionsOp.filters, [
    ["in:resman_unit_id", ["unit-1", "unit-2"]],
    ["is:deleted_at", null],
  ]);
  assert.deepEqual(actionsOp.orderBy, [["created_at", { ascending: false }]]);
});

// --- POST /manager/delinquency-actions ------------------------------------

test("create rejects malformed bodies without touching the DB", async () => {
  state.auth = tokenAuth();
  state.db = untouchableDb();

  const badBodies = [
    {},
    { resmanLeaseId: "", kind: "note" },
    { resmanLeaseId: "lease-1", kind: "phoned" },
    { resmanLeaseId: "lease-1", kind: "note", amount: -5 },
    { resmanLeaseId: "lease-1", kind: "note", promiseDueDate: "2026-08-01" }, // wrong kind
    { resmanLeaseId: "lease-1", kind: "promise_recorded", promiseDueDate: "08/01/2026" },
  ];
  for (const body of badBodies) {
    const response = await actionsRoute.POST(jsonPost("/delinquency-actions", body));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error, "Invalid request");
  }

  const noBody = await actionsRoute.POST(
    managerRequest("/delinquency-actions", { method: "POST" }),
  );
  assert.equal(noBody.status, 400);
});

test("create stores the action with token attribution and answers 201", async () => {
  const operations = [];
  const stored = {
    id: ACTION_ID,
    resman_lease_id: "lease-9",
    resman_unit_id: "unit-9",
    unit_number: "1809 BA-4",
    kind: "promise_recorded",
    note: "Promised Friday",
    amount: 350,
    promise_due_date: "2026-07-24",
    created_by: "Priya Manager",
    created_at: "2026-07-20T16:00:00.000Z",
  };
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [{ table: "delinquency_actions", insert: { data: stored, error: null } }],
    operations,
  );

  const response = await actionsRoute.POST(
    jsonPost("/delinquency-actions", {
      resmanLeaseId: "lease-9",
      resmanUnitId: "unit-9",
      unitNumber: "1809 BA-4",
      kind: "promise_recorded",
      note: "Promised Friday",
      amount: 350,
      promiseDueDate: "2026-07-24",
    }),
  );
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    data: {
      id: ACTION_ID,
      resmanLeaseId: "lease-9",
      resmanUnitId: "unit-9",
      unitNumber: "1809 BA-4",
      kind: "promise_recorded",
      note: "Promised Friday",
      amount: 350,
      promiseDueDate: "2026-07-24",
      createdBy: "Priya Manager",
      createdAt: "2026-07-20T16:00:00.000Z",
    },
  });

  assert.deepEqual(operations[0].values, {
    resman_lease_id: "lease-9",
    resman_unit_id: "unit-9",
    unit_number: "1809 BA-4",
    kind: "promise_recorded",
    note: "Promised Friday",
    amount: 350,
    promise_due_date: "2026-07-24",
    created_by: "Priya Manager",
    created_by_admin_id: "admin-7",
  });
});

test("create defaults the optional fields to empty/null", async () => {
  const operations = [];
  const stored = {
    id: ACTION_ID,
    resman_lease_id: "lease-9",
    resman_unit_id: "",
    unit_number: "",
    kind: "called",
    note: "",
    amount: null,
    promise_due_date: null,
    created_by: "Priya Manager",
    created_at: "2026-07-20T16:00:00.000Z",
  };
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [{ table: "delinquency_actions", insert: { data: stored, error: null } }],
    operations,
  );

  const response = await actionsRoute.POST(
    jsonPost("/delinquency-actions", { resmanLeaseId: "lease-9", kind: "called" }),
  );
  assert.equal(response.status, 201);
  assert.deepEqual(operations[0].values, {
    resman_lease_id: "lease-9",
    resman_unit_id: "",
    unit_number: "",
    kind: "called",
    note: "",
    amount: null,
    promise_due_date: null,
    created_by: "Priya Manager",
    created_by_admin_id: "admin-7",
  });
});

// --- DELETE /manager/delinquency-actions/[id] ------------------------------

test("delete soft-deletes a live action", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [
      { table: "delinquency_actions", select: { data: { id: ACTION_ID }, error: null } },
      { table: "delinquency_actions", update: { error: null } },
    ],
    operations,
  );

  const response = await actionIdRoute.DELETE(
    managerRequest(`/delinquency-actions/${ACTION_ID}`, { method: "DELETE" }),
    actionIdParams,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { deleted: true } });

  const [selectOp, updateOp] = operations;
  assert.deepEqual(selectOp.filters, [
    ["id", ACTION_ID],
    ["is:deleted_at", null],
  ]);
  assert.deepEqual(updateOp.filters, [["id", ACTION_ID]]);
  assert.match(updateOp.patch.deleted_at, /^20\d{2}-/);
});

test("delete answers 404 for unknown or already-deleted actions", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [{ table: "delinquency_actions", select: { data: null, error: null } }],
    operations,
  );

  const response = await actionIdRoute.DELETE(
    managerRequest(`/delinquency-actions/${ACTION_ID}`, { method: "DELETE" }),
    actionIdParams,
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "Action not found");
  assert.equal(operations.length, 1); // no update issued
});

test("delete answers 404 for a malformed id without touching the DB", async () => {
  state.auth = tokenAuth();
  state.db = untouchableDb();

  const response = await actionIdRoute.DELETE(
    managerRequest("/delinquency-actions/not-a-uuid", { method: "DELETE" }),
    { params: Promise.resolve({ id: "not-a-uuid" }) },
  );
  assert.equal(response.status, 404);
});

// --- GET /manager/ledger-summary ------------------------------------------

test("GET ledger-summary aggregates the paged transaction mirror", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [
      {
        table: "resman_transactions",
        select: {
          data: [
            ledgerEntry({ date: "2026-06-01", ledger_sequence: 0, charges: 900, balance: 900 }),
            ledgerEntry({ date: "2026-06-20", ledger_sequence: 1, credits: 900, balance: 0 }),
          ],
          error: null,
        },
      },
    ],
    operations,
  );

  const response = await ledgerSummaryRoute.GET(managerRequest("/ledger-summary"));
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(data.leases, [
    {
      leaseId: "lease-1",
      billed: 900,
      collected: 900,
      lastPaymentDate: "2026-06-20",
      firstLateMonth: null,
      concessions: 0,
      writeoffs: 0,
      legalFiledDate: null,
      legalFees: 0,
      composition: { rent: 0, late: 0, utility: 0, legal: 0, insurance: 0, moveout: 0, other: 0 },
      owed: 0,
      credit: 0,
      rentOwed: 0,
    },
  ]);

  // One page (< page size stops), lease-linked rows only, PK-ordered paging.
  const [op] = operations;
  assert.deepEqual(op.filters, [["not:resman_lease_id", "is", null]]);
  assert.deepEqual(op.orderBy, [["resman_ledger_entry_id", { ascending: true }]]);
  assert.deepEqual(op.range, [0, 999]);
});

// --- GET /manager/ledger --------------------------------------------------

test("GET ledger requires leaseId", async () => {
  state.auth = tokenAuth();
  state.db = untouchableDb();

  for (const path of ["/ledger", "/ledger?leaseId=", "/ledger?leaseId=%20"]) {
    const response = await ledgerRoute.GET(managerRequest(path));
    assert.equal(response.status, 400, path);
    assert.equal((await response.json()).error, "Missing leaseId");
  }
});

test("GET ledger returns one lease's entries newest first, capped", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [
      {
        table: "resman_transactions",
        select: {
          data: [
            {
              resman_ledger_entry_id: "txn-2",
              date: "2026-07-05",
              transaction_type: "Payment",
              category: "Rent",
              ledger_description: "July payment",
              charges: null,
              credits: 1150,
              balance: 0,
            },
          ],
          error: null,
        },
      },
    ],
    operations,
  );

  const response = await ledgerRoute.GET(managerRequest("/ledger?leaseId=lease-1"));
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(data.entries, [
    {
      id: "txn-2",
      date: "2026-07-05",
      transactionType: "Payment",
      category: "Rent",
      description: "July payment",
      charges: null,
      credits: 1150,
      balance: 0,
    },
  ]);

  const [op] = operations;
  assert.deepEqual(op.filters, [["resman_lease_id", "lease-1"]]);
  assert.deepEqual(op.orderBy, [
    ["date", { ascending: false }],
    ["ledger_sequence", { ascending: false }],
  ]);
  assert.equal(op.limit, 500);
});

// --- GET /manager/mlgw ----------------------------------------------------

test("GET mlgw returns accounts, current bills, monthly totals, and reviews", async () => {
  const thisMonth = monthKey(Date.now(), 0);
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [
      {
        table: "mlgw_accounts",
        select: {
          data: [
            {
              id: "acct-1",
              account_number: "700123",
              service_address: "1809 Bailey Ave Apt 1",
              unit_number: "1809 BA-1",
              is_house_account: false,
              due_now: 182.4,
              due_date: "2026-08-01",
            },
          ],
          error: null,
        },
      },
      {
        table: "mlgw_bills",
        select: {
          data: [
            {
              id: "bill-1",
              mlgw_account_id: "acct-1",
              bill_date: `${thisMonth}-05`,
              due_date: "2026-08-01",
              amount_due: 182.4,
              balance_forward: 0,
              gas_total: 20.1,
              electric_total: 95.3,
              water_total: 30,
              sewer_total: 15,
              other_mlgw_total: null,
              non_mlgw_total: null,
              street_light_fee_total: 2,
              electrical_late_fee_total: null,
              security_deposit_total: null,
              smart_meter_connect_charge_total: null,
              credit_balance_transfer_total: null,
              share_the_pennies_total: 1,
              water_cross_connection_fee_total: null,
              leasing_outdoor_lighting_total: null,
              mosquito_rodent_control_fee_total: 3,
              sewer_charge_total: null,
              storm_water_fee_total: 8,
              solid_waste_fee_total: 8,
            },
          ],
          error: null,
        },
      },
      {
        table: "mlgw_bills",
        select: {
          data: [
            { bill_date: `${thisMonth}-05`, amount_due: 182.4 },
            { bill_date: `${thisMonth}-06`, amount_due: 90 },
          ],
          error: null,
        },
      },
      {
        table: "mlgw_exception_reviews",
        select: {
          data: [
            {
              id: "prop-1|bill-1|late_fee",
              bill_id: "bill-1",
              account_number: "700123",
              exception_kind: "late_fee",
              reviewed_at: "2026-07-19T12:00:00.000Z",
            },
          ],
          error: null,
        },
      },
    ],
    operations,
  );

  const response = await mlgwRoute.GET(managerRequest("/mlgw"));
  assert.equal(response.status, 200);
  const { data } = await response.json();

  assert.deepEqual(data.accounts, [
    {
      id: "acct-1",
      accountNumber: "700123",
      serviceAddress: "1809 Bailey Ave Apt 1",
      unitNumber: "1809 BA-1",
      isHouseAccount: false,
      dueNow: 182.4,
      dueDate: "2026-08-01",
    },
  ]);
  assert.equal(data.currentBills.length, 1);
  const bill = data.currentBills[0];
  assert.equal(bill.id, "bill-1");
  assert.equal(bill.accountId, "acct-1");
  assert.equal(bill.amountDue, 182.4);
  assert.equal(bill.gasTotal, 20.1);
  assert.equal(bill.electricTotal, 95.3);
  assert.equal(bill.stormWaterFeeTotal, 8);
  assert.equal(bill.mosquitoRodentControlFeeTotal, 3);
  assert.equal(bill.shareThePenniesTotal, 1);
  assert.deepEqual(data.monthlyTotals, [{ month: thisMonth, total: 272.4, billCount: 2 }]);
  assert.deepEqual(data.reviews, [
    {
      id: "prop-1|bill-1|late_fee",
      billId: "bill-1",
      accountNumber: "700123",
      exceptionKind: "late_fee",
      reviewedAt: "2026-07-19T12:00:00.000Z",
    },
  ]);

  // Current bills filter + the 12-month window floor on the series query.
  assert.deepEqual(operations[1].filters, [["is_current", true]]);
  assert.deepEqual(operations[2].filters, [["gte:bill_date", `${monthKey(Date.now(), 11)}-01`]]);
});

// --- POST /manager/mlgw-reviews -------------------------------------------

test("mlgw-reviews rejects malformed bodies without touching the DB", async () => {
  state.auth = tokenAuth();
  state.db = untouchableDb();

  const badBodies = [
    {},
    { billId: "bill-1", exceptionKind: "late_fee" }, // reviewed missing
    { billId: "", exceptionKind: "late_fee", reviewed: true },
    { billId: "bill-1", exceptionKind: "", reviewed: true },
    { billId: "bill-1", exceptionKind: "late_fee", reviewed: "yes" },
  ];
  for (const body of badBodies) {
    const response = await mlgwReviewsRoute.POST(jsonPost("/mlgw-reviews", body));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error, "Invalid request");
  }
});

test("reviewed=true resolves the property from the bill and upserts", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [
      {
        table: "mlgw_bills",
        select: { data: { id: "bill-1", resman_property_id: "prop-1" }, error: null },
      },
      { table: "mlgw_exception_reviews", upsert: { error: null } },
    ],
    operations,
  );

  const response = await mlgwReviewsRoute.POST(
    jsonPost("/mlgw-reviews", {
      billId: "bill-1",
      accountNumber: "700123",
      exceptionKind: "late_fee",
      reviewed: true,
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { reviewed: true } });

  const [billOp, upsertOp] = operations;
  assert.deepEqual(billOp.filters, [["id", "bill-1"]]);
  assert.equal(upsertOp.values.id, "prop-1|bill-1|late_fee");
  assert.equal(upsertOp.values.resman_property_id, "prop-1");
  assert.equal(upsertOp.values.bill_id, "bill-1");
  assert.equal(upsertOp.values.account_number, "700123");
  assert.equal(upsertOp.values.exception_kind, "late_fee");
  assert.match(upsertOp.values.reviewed_at, /^20\d{2}-/);
  assert.deepEqual(upsertOp.upsertOptions, { onConflict: "id" });
});

test("reviewed=true answers 404 when the bill is unknown", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [{ table: "mlgw_bills", select: { data: null, error: null } }],
    operations,
  );

  const response = await mlgwReviewsRoute.POST(
    jsonPost("/mlgw-reviews", { billId: "gone", exceptionKind: "late_fee", reviewed: true }),
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "Bill not found");
  assert.equal(operations.length, 1); // no upsert issued
});

test("reviewed=false clears the row by bill and kind, no bill lookup", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [{ table: "mlgw_exception_reviews", delete: { error: null } }],
    operations,
  );

  const response = await mlgwReviewsRoute.POST(
    jsonPost("/mlgw-reviews", { billId: "bill-1", exceptionKind: "late_fee", reviewed: false }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { reviewed: false } });

  const [op] = operations;
  assert.equal(op.action, "delete");
  assert.deepEqual(op.filters, [
    ["bill_id", "bill-1"],
    ["exception_kind", "late_fee"],
  ]);
});

// --- GET /manager/renewal-offers ------------------------------------------

function offerRow(overrides = {}) {
  return {
    id: OFFER_ID,
    resman_lease_id: "lease-1",
    resman_unit_id: "unit-1",
    unit_number: "0327",
    prior_rent: 1240,
    proposed_rent: 1335,
    term_months: 14,
    is_month_to_month: false,
    status: "sent",
    sent_at: "2026-07-10T15:00:00.000Z",
    responded_at: null,
    note: "",
    created_by: "Priya Manager",
    created_at: "2026-07-10T15:00:00.000Z",
    ...overrides,
  };
}

test("GET renewal-offers returns live offers newest first as camelCase DTOs", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [{ table: "renewal_offers", select: { data: [offerRow()], error: null } }],
    operations,
  );

  const response = await renewalOffersRoute.GET(managerRequest("/renewal-offers"));
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(data.offers, [
    {
      id: OFFER_ID,
      resmanLeaseId: "lease-1",
      resmanUnitId: "unit-1",
      unitNumber: "0327",
      priorRent: 1240,
      proposedRent: 1335,
      termMonths: 14,
      isMonthToMonth: false,
      status: "sent",
      sentAt: "2026-07-10T15:00:00.000Z",
      respondedAt: null,
      note: "",
      createdBy: "Priya Manager",
      createdAt: "2026-07-10T15:00:00.000Z",
    },
  ]);

  const [op] = operations;
  assert.deepEqual(op.filters, [["is:deleted_at", null]]);
  assert.deepEqual(op.orderBy, [["created_at", { ascending: false }]]);
});

// --- POST /manager/renewal-offers -----------------------------------------

test("offer create rejects malformed bodies without touching the DB", async () => {
  state.auth = tokenAuth();
  state.db = untouchableDb();

  const badBodies = [
    {},
    { resmanLeaseId: "", proposedRent: 1200 },
    { resmanLeaseId: "lease-1" }, // proposedRent missing
    { resmanLeaseId: "lease-1", proposedRent: -5 },
    { resmanLeaseId: "lease-1", proposedRent: 1200, termMonths: 2.5 },
    { resmanLeaseId: "lease-1", proposedRent: 1200, termMonths: 0 },
    // MTM and a fixed term are mutually exclusive.
    { resmanLeaseId: "lease-1", proposedRent: 1200, termMonths: 12, isMonthToMonth: true },
  ];
  for (const body of badBodies) {
    const response = await renewalOffersRoute.POST(jsonPost("/renewal-offers", body));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error, "Invalid request");
  }

  const noBody = await renewalOffersRoute.POST(
    managerRequest("/renewal-offers", { method: "POST" }),
  );
  assert.equal(noBody.status, 400);
});

test("offer create stores the offer with token attribution and answers 201", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [{ table: "renewal_offers", insert: { data: offerRow(), error: null } }],
    operations,
  );

  const response = await renewalOffersRoute.POST(
    jsonPost("/renewal-offers", {
      resmanLeaseId: "lease-1",
      resmanUnitId: "unit-1",
      unitNumber: "0327",
      priorRent: 1240,
      proposedRent: 1335,
      termMonths: 14,
      note: "",
    }),
  );
  assert.equal(response.status, 201);
  const { data } = await response.json();
  assert.equal(data.id, OFFER_ID);
  assert.equal(data.status, "sent");
  assert.equal(data.proposedRent, 1335);

  assert.deepEqual(operations[0].values, {
    resman_lease_id: "lease-1",
    resman_unit_id: "unit-1",
    unit_number: "0327",
    prior_rent: 1240,
    proposed_rent: 1335,
    term_months: 14,
    is_month_to_month: false,
    note: "",
    created_by: "Priya Manager",
    created_by_admin_id: "admin-7",
  });
});

test("offer create defaults optionals: an MTM offer stores null term", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [
      {
        table: "renewal_offers",
        insert: {
          data: offerRow({ term_months: null, is_month_to_month: true, prior_rent: null }),
          error: null,
        },
      },
    ],
    operations,
  );

  const response = await renewalOffersRoute.POST(
    jsonPost("/renewal-offers", {
      resmanLeaseId: "lease-1",
      proposedRent: 1390,
      isMonthToMonth: true,
    }),
  );
  assert.equal(response.status, 201);
  assert.deepEqual(operations[0].values, {
    resman_lease_id: "lease-1",
    resman_unit_id: "",
    unit_number: "",
    prior_rent: null,
    proposed_rent: 1390,
    term_months: null,
    is_month_to_month: true,
    note: "",
    created_by: "Priya Manager",
    created_by_admin_id: "admin-7",
  });
});

// --- PATCH /manager/renewal-offers/[id] -----------------------------------

test("offer resolve rejects malformed bodies without touching the DB", async () => {
  state.auth = tokenAuth();
  state.db = untouchableDb();

  const badBodies = [{}, { status: "sent" }, { status: "ghosted" }, { status: 1 }];
  for (const body of badBodies) {
    const response = await renewalOfferIdRoute.PATCH(
      jsonPatch(`/renewal-offers/${OFFER_ID}`, body),
      offerIdParams,
    );
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error, "Invalid request");
  }
});

test("offer resolve stamps responded_at and returns the updated offer", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [
      { table: "renewal_offers", select: { data: { id: OFFER_ID, status: "sent" }, error: null } },
      {
        table: "renewal_offers",
        update: {
          data: offerRow({ status: "accepted", responded_at: "2026-07-21T12:00:00.000Z" }),
          error: null,
        },
      },
    ],
    operations,
  );

  const response = await renewalOfferIdRoute.PATCH(
    jsonPatch(`/renewal-offers/${OFFER_ID}`, { status: "accepted" }),
    offerIdParams,
  );
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.status, "accepted");
  assert.equal(data.respondedAt, "2026-07-21T12:00:00.000Z");

  const [selectOp, updateOp] = operations;
  assert.deepEqual(selectOp.filters, [
    ["id", OFFER_ID],
    ["is:deleted_at", null],
  ]);
  assert.deepEqual(updateOp.filters, [["id", OFFER_ID]]);
  assert.equal(updateOp.patch.status, "accepted");
  assert.match(updateOp.patch.responded_at, /^20\d{2}-/);
});

test("offer resolve answers 400 once the offer already resolved", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [
      {
        table: "renewal_offers",
        select: { data: { id: OFFER_ID, status: "accepted" }, error: null },
      },
    ],
    operations,
  );

  const response = await renewalOfferIdRoute.PATCH(
    jsonPatch(`/renewal-offers/${OFFER_ID}`, { status: "declined" }),
    offerIdParams,
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Offer already resolved");
  assert.equal(operations.length, 1); // no update issued
});

test("offer resolve answers 404 for unknown or deleted offers", async () => {
  const operations = [];
  state.auth = tokenAuth();
  state.db = scriptedSupabase(
    [{ table: "renewal_offers", select: { data: null, error: null } }],
    operations,
  );

  const response = await renewalOfferIdRoute.PATCH(
    jsonPatch(`/renewal-offers/${OFFER_ID}`, { status: "withdrawn" }),
    offerIdParams,
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "Offer not found");
  assert.equal(operations.length, 1);
});

test("offer resolve answers 404 for a malformed id without touching the DB", async () => {
  state.auth = tokenAuth();
  state.db = untouchableDb();

  const response = await renewalOfferIdRoute.PATCH(
    jsonPatch("/renewal-offers/not-a-uuid", { status: "accepted" }),
    { params: Promise.resolve({ id: "not-a-uuid" }) },
  );
  assert.equal(response.status, 404);
});
