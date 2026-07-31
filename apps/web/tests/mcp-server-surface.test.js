const assert = require("node:assert/strict");
const test = require("node:test");

const { handleMcpMessage } = require("../lib/mcp/server");
const { redactAuditArgs } = require("../lib/access-tokens");
const { aggregateRelated } = require("../lib/resman-api");
const { unitsResource, transactionsResource, RESMAN_RESOURCES } = require("../lib/resman-resources");

/**
 * The MCP surface beyond the query resolvers: audit redaction, the prompts and
 * resources primitives, per-token budgeting, and aggregation ACROSS a relation.
 *
 * These are the parts where a mistake is silent — a leaked search term looks
 * like a normal log row, and an out-of-scope prompt looks like a helpful one.
 */

const staff = (scopes) => ({
  tokenId: "tok-1",
  kind: "mcp",
  subjectType: "admin_user",
  subjectId: "user-1",
  label: "test",
  role: "staff",
  scopes,
});

/** A client that records inserts and answers reads with canned rows. */
function fakeClient({ rows = {}, onInsert = () => {} } = {}) {
  const make = (table, state) => {
    const self = {
      insert(payload) {
        onInsert(table, payload);
        return Promise.resolve({ data: null, error: null });
      },
      select(_cols, opts) {
        return make(table, { ...state, head: Boolean(opts && opts.head) });
      },
      eq: () => make(table, state),
      is: () => make(table, state),
      gte: () => make(table, state),
      lte: () => make(table, state),
      or: () => make(table, state),
      in(_column, keys) {
        return make(table, { ...state, keys });
      },
      order: () => make(table, state),
      range: () => make(table, state),
      limit: () => make(table, state),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then(resolve) {
        const data = typeof rows[table] === "function" ? rows[table](state) : (rows[table] ?? []);
        return resolve({ data, error: null, count: data.length });
      },
    };
    return self;
  };
  return { from: (table) => make(table, {}) };
}

// ------------------------------------------------------------- redaction ---

test("a search term never reaches the audit log verbatim", () => {
  const out = redactAuditArgs({ resource: "residents", search: "hernandez", limit: 50 });
  assert.equal(out.resource, "residents", "structural args are kept — they are the audit trail");
  assert.equal(out.limit, 50);
  assert.equal(out.search.redacted, true);
  assert.equal(out.search.length, 9);
  assert.ok(!JSON.stringify(out).includes("hernandez"), "the term must not survive anywhere in the row");
});

test("the same term redacts to the same digest, a different term to a different one", () => {
  const a = redactAuditArgs({ search: "smith" });
  const b = redactAuditArgs({ search: "smith" });
  const c = redactAuditArgs({ search: "jones" });
  assert.equal(a.search.digest, b.search.digest, "repeat searches stay correlatable");
  assert.notEqual(a.search.digest, c.search.digest);
});

test("redaction reaches nested and aliased free-text keys", () => {
  const out = redactAuditArgs({ outer: { q: "comcast" }, list: [{ search: "leak" }] });
  const flat = JSON.stringify(out);
  assert.ok(!flat.includes("comcast"));
  assert.ok(!flat.includes("leak"));
});

test("redaction terminates on a cyclic argument object", () => {
  const cyclic = { search: "x" };
  cyclic.self = cyclic;
  const out = redactAuditArgs(cyclic);
  assert.ok(JSON.stringify(out).length > 0, "depth cap prevents the logger hanging on a cycle");
});

test("logAccessTokenUse redacts before insert, not at the call site", async () => {
  const { logAccessTokenUse } = require("../lib/access-tokens");
  let inserted = null;
  const client = fakeClient({ onInsert: (_t, payload) => { inserted = payload; } });
  await logAccessTokenUse(client, staff(["*"]), {
    tool: "query_resource",
    resource: "residents",
    args: { search: "garcia" },
    ok: true,
  });
  assert.ok(inserted, "the audit row was written");
  assert.ok(!JSON.stringify(inserted).includes("garcia"));
});

// --------------------------------------------------------------- prompts ---

test("prompts are hidden from a token that cannot read what they would query", async () => {
  const full = await handleMcpMessage({ id: 1, method: "prompts/list" }, { staff: staff(["*"]), client: fakeClient() });
  const names = full.result.prompts.map((p) => p.name);
  assert.ok(names.includes("occupancy_reconciliation"));
  assert.ok(names.includes("gate_activity"));

  const narrow = await handleMcpMessage(
    { id: 2, method: "prompts/list" },
    { staff: staff(["work-orders"]), client: fakeClient() },
  );
  const narrowNames = narrow.result.prompts.map((p) => p.name);
  assert.deepEqual(narrowNames, ["work_order_aging"], "only the prompt whose resources are in scope");
});

test("fetching an out-of-scope prompt reads as unknown, not as forbidden", async () => {
  // A distinct 'not authorized' would confirm the prompt (and its resources)
  // exist to a token that cannot use them.
  const res = await handleMcpMessage(
    { id: 3, method: "prompts/get", params: { name: "gate_activity" } },
    { staff: staff(["work-orders"]), client: fakeClient() },
  );
  assert.match(res.error.message, /Unknown prompt/);
});

test("a prompt interpolates its arguments into the workflow it hands back", async () => {
  const res = await handleMcpMessage(
    { id: 4, method: "prompts/get", params: { name: "utility_spend", arguments: { from: "2026-01-01", to: "2026-03-31" } } },
    { staff: staff(["*"]), client: fakeClient() },
  );
  const text = res.result.messages[0].content.text;
  assert.ok(text.includes("2026-01-01") && text.includes("2026-03-31"));
  assert.ok(text.includes("(unmatched)"), "the address-match caveat travels with the prompt");
});

// ------------------------------------------------------------- resources ---

test("the catalog resource is filtered to the token's scopes", async () => {
  const res = await handleMcpMessage(
    { id: 5, method: "resources/read", params: { uri: "emberly://catalog" } },
    { staff: staff(["units"]), client: fakeClient() },
  );
  const catalog = JSON.parse(res.result.contents[0].text);
  assert.deepEqual(catalog.resources.map((r) => r.resource), ["units"]);
});

test("the traps resource carries the occupancy gap", async () => {
  const res = await handleMcpMessage(
    { id: 6, method: "resources/read", params: { uri: "emberly://data-traps" } },
    { staff: staff(["*"]), client: fakeClient() },
  );
  assert.match(res.result.contents[0].text, /occupied vs occupancy_status/);
});

test("initialize advertises tools, prompts and resources", async () => {
  const res = await handleMcpMessage({ id: 7, method: "initialize", params: {} }, { staff: staff(["*"]), client: fakeClient() });
  assert.ok(res.result.capabilities.tools);
  assert.ok(res.result.capabilities.prompts);
  assert.ok(res.result.capabilities.resources);
});

// -------------------------------------------------- aggregate_related ------

test("aggregate_related folds child rows into the parent's group", async () => {
  // Two units in building A, one in B; transactions attached to each.
  const client = fakeClient({
    rows: {
      resman_units: [
        { resman_unit_id: "u1", resman_building_id: "A" },
        { resman_unit_id: "u2", resman_building_id: "A" },
        { resman_unit_id: "u3", resman_building_id: "B" },
      ],
      resman_transactions: [
        { resman_unit_id: "u1", charges: 100 },
        { resman_unit_id: "u2", charges: 50 },
        { resman_unit_id: "u3", charges: 25 },
        { resman_unit_id: "u1", charges: null }, // must not count as a zero
      ],
    },
  });

  const result = await aggregateRelated(
    unitsResource,
    transactionsResource,
    { name: "transactions", localColumn: "resman_unit_id", foreignColumn: "resman_unit_id" },
    new URLSearchParams(),
    { groupBy: "resman_building_id", metric: "sum", measure: "charges" },
    client,
  );

  const byGroup = Object.fromEntries(result.buckets.map((b) => [b.group, b]));
  assert.equal(byGroup.A.value, 150);
  assert.equal(byGroup.B.value, 25);
  assert.equal(byGroup.A.count, 2, "the null-charge row is excluded, as in SQL");
  assert.equal(result.grouped_by_resource, "units");
  assert.equal(result.resource, "transactions");
});

test("aggregate_related reports rows it could not attribute instead of dropping them", async () => {
  const client = fakeClient({
    rows: {
      resman_units: [{ resman_unit_id: "u1", resman_building_id: "A" }],
      resman_transactions: [
        { resman_unit_id: "u1", charges: 10 },
        { resman_unit_id: "ghost", charges: 999 }, // no parent scanned
      ],
    },
  });
  const result = await aggregateRelated(
    unitsResource,
    transactionsResource,
    { name: "transactions", localColumn: "resman_unit_id", foreignColumn: "resman_unit_id" },
    new URLSearchParams(),
    { groupBy: "resman_building_id", metric: "sum", measure: "charges" },
    client,
  );
  const unmatched = result.buckets.find((b) => b.group === "(unmatched)");
  assert.ok(unmatched, "an unattributable row is surfaced, not silently discarded");
  assert.equal(unmatched.count, 1);
});

test("aggregate_related rejects a measure the TARGET resource does not declare", async () => {
  // Reaching a column through a join must not bypass the resource that owns it.
  const res = await handleMcpMessage(
    {
      id: 8,
      method: "tools/call",
      params: {
        name: "aggregate_related",
        arguments: { resource: "units", relation: "transactions", group_by: "occupancy_status", metric: "sum", measure: "market_rent" },
      },
    },
    { staff: staff(["*"]), client: fakeClient() },
  );
  // market_rent is a measure on UNITS, not on transactions.
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /not a measure on transactions/);
});

test("aggregate_related refuses a 'one' hop and names the way round", async () => {
  const res = await handleMcpMessage(
    {
      id: 9,
      method: "tools/call",
      params: { name: "aggregate_related", arguments: { resource: "units", relation: "current_lease" } },
    },
    { staff: staff(["*"]), client: fakeClient() },
  );
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /"one" hop/);
});

test("a relation's target is scope-checked independently of the parent", async () => {
  const res = await handleMcpMessage(
    {
      id: 10,
      method: "tools/call",
      params: { name: "aggregate_related", arguments: { resource: "units", relation: "transactions" } },
    },
    { staff: staff(["units"]), client: fakeClient() },
  );
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /Not authorized for resource "transactions"/);
});

// ---------------------------------------------------- capability coverage ---

test("every resource declares at least one capability beyond listing", () => {
  // A resource with no searchable/range/groupable/measure/relation is reachable
  // only as an undifferentiated list, which is how the MLGW and gate tables sat
  // for a release. Adding a resource without capabilities should fail here.
  for (const r of RESMAN_RESOURCES) {
    const total =
      r.searchable.length + Object.keys(r.ranges).length + r.groupable.length +
      r.measures.length + r.relations.length;
    assert.ok(total > 0, `${r.name} declares no capabilities — it can only be listed`);
  }
});

test("the money and gate tables carry the capabilities their questions need", () => {
  const by = Object.fromEntries(RESMAN_RESOURCES.map((r) => [r.name, r]));
  // "What did we spend on water in Q1" needs a date range and a measure.
  assert.ok(Object.keys(by["mlgw/bills"].ranges).includes("bill_date"));
  assert.ok(by["mlgw/bills"].measures.includes("water_total"));
  // "Who came through the gate last night" needs a range on entered_at.
  assert.ok(Object.keys(by["entry-logs"].ranges).includes("entered"));
  assert.ok(by["mlgw/payments"].measures.includes("amount"));
});
