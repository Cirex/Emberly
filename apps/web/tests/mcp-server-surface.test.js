const assert = require("node:assert/strict");
const test = require("node:test");

const { handleMcpMessage } = require("../lib/mcp/server");
const { redactAuditArgs } = require("../lib/access-tokens");
const { aggregateRelated, aggregateResource } = require("../lib/resman-api");
const {
  unitsResource,
  transactionsResource,
  workOrdersResource,
  entryLogsResource,
  mlgwPaymentsResource,
  RESMAN_RESOURCES,
} = require("../lib/resman-resources");

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

// ------------------------------------------- in-memory PostgREST-ish fake ---

/**
 * A client that actually applies the predicates, so the count strategy (one
 * HEAD query per bucket) is exercised rather than stubbed.
 */
function memClient(tables) {
  const build = (rows, state) => ({
    eq: (c, v) => build(rows.filter((r) => String(r[c]) === String(v)), state),
    is: (c, v) => build(rows.filter((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)), state),
    not: (c) => build(rows.filter((r) => r[c] !== null && r[c] !== undefined), state),
    gte: (c, v) => build(rows.filter((r) => r[c] != null && String(r[c]) >= String(v)), state),
    lte: (c, v) => build(rows.filter((r) => r[c] != null && String(r[c]) <= String(v)), state),
    lt: (c, v) => build(rows.filter((r) => r[c] != null && String(r[c]) < String(v)), state),
    or: () => build(rows, state),
    order: (c, opts) => {
      const sorted = [...rows].sort((a, b) => String(a[c] ?? "").localeCompare(String(b[c] ?? "")));
      return build(opts && opts.ascending === false ? sorted.reverse() : sorted, state);
    },
    limit: (n) => build(rows.slice(0, n), state),
    range: () => build(rows, state),
    maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    then: (resolve) => resolve({ data: state.head ? null : rows, error: null, count: rows.length }),
  });
  return {
    from: (table) => ({
      select: (_cols, opts) => build(tables[table] ?? [], { head: Boolean(opts && opts.head) }),
    }),
  };
}

// ---------------------------------------------------------- SQL grouping ---

/** A client whose `rpc` records its arguments and replays canned rows. */
function rpcClient(rows, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    rpc(name, args) {
      calls.push({ name, args });
      if (fail) return Promise.resolve({ data: null, error: { message: "function does not exist", code: "42883" } });
      return Promise.resolve({ data: rows, error: null });
    },
    from: () => ({
      select: () => ({
        eq() { return this; }, is() { return this; }, not() { return this; },
        gte() { return this; }, lte() { return this; }, lt() { return this; },
        or() { return this; }, order() { return this; }, limit() { return this; },
        range() { return this; },
        then: (resolve) => resolve({ data: [], error: null, count: 0 }),
      }),
    }),
  };
}

test("grouping happens in Postgres when the RPC is available", async () => {
  // One request instead of 33, and the group set is EXACT rather than sampled —
  // on the live mirror this returned 39 transaction categories where the
  // 5,000-row sample had only ever seen 23.
  const client = rpcClient([
    { grp: "Occupied", period: null, n: 508, val: null },
    { grp: "Vacant", period: null, n: 325, val: null },
  ]);
  const result = await aggregateResource(
    unitsResource,
    new URLSearchParams(),
    { groupBy: "occupancy_status", groupValues: [], metric: "count", measure: null },
    client,
  );
  assert.equal(result.engine, "sql");
  assert.equal(client.calls.length, 1, "one round trip");
  assert.equal(client.calls[0].args.p_table, "resman_units");
  assert.equal(client.calls[0].args.p_group_by, "occupancy_status");
  assert.deepEqual(result.buckets.map((b) => [b.group, b.count]), [["Occupied", 508], ["Vacant", 325]]);
  assert.equal(result.total, 833);
  // The sampled-domain workaround is unnecessary when the domain is exact.
  assert.ok(!result.buckets.some((b) => b.group === "(other)"));
});

test("filters, ranges and search are handed to SQL, not re-implemented", async () => {
  const client = rpcClient([]);
  await aggregateResource(
    workOrdersResource,
    new URLSearchParams({ status: "Not Started", reported_from: "2026-01-01", q: "comcast" }),
    { groupBy: "status", groupValues: [], metric: "count", measure: null },
    client,
  );
  const { p_filters, p_search_columns, p_search_term } = client.calls[0].args;
  assert.deepEqual(p_filters, [
    { col: "status", op: "eq", val: "Not Started" },
    { col: "date_reported", op: "gte", val: "2026-01-01" },
  ]);
  assert.equal(p_search_term, "comcast");
  assert.deepEqual([...p_search_columns], [...workOrdersResource.searchable]);
});

test("a DATE period is sent with no timezone; a TIMESTAMP period carries one", async () => {
  // Passing a zone for a plain DATE would shift every boundary by the offset.
  const dateClient = rpcClient([]);
  await aggregateResource(
    workOrdersResource, new URLSearchParams(),
    { groupBy: null, groupValues: [], metric: "count", measure: null,
      period: { column: "date_reported", kind: "date", interval: "month", timezone: "America/Chicago" } },
    dateClient,
  );
  assert.equal(dateClient.calls[0].args.p_period_tz, null);

  const tsClient = rpcClient([]);
  await aggregateResource(
    entryLogsResource, new URLSearchParams(),
    { groupBy: null, groupValues: [], metric: "count", measure: null,
      period: { column: "entered_at", kind: "timestamp", interval: "day", timezone: "America/Chicago" } },
    tsClient,
  );
  assert.equal(tsClient.calls[0].args.p_period_tz, "America/Chicago");
});

test("the SQL path fills the gaps SQL leaves in a series", async () => {
  // GROUP BY returns only periods that HAVE rows, so a month with none simply
  // vanishes — and a series that skips a month reads as continuous.
  const client = rpcClient([
    { grp: null, period: "2026-01", n: 2, val: 150 },
    { grp: null, period: "2026-04", n: 1, val: 25 },
  ]);
  const result = await aggregateResource(
    transactionsResource, new URLSearchParams(),
    { groupBy: null, groupValues: [], metric: "sum", measure: "charges",
      period: { column: "date", kind: "date", interval: "month", timezone: "America/Chicago" } },
    client,
  );
  assert.deepEqual(
    result.buckets.map((b) => [b.period, b.value]),
    [["2026-01", 150], ["2026-02", null], ["2026-03", null], ["2026-04", 25]],
  );
});

test("an unavailable RPC falls back to the scan path rather than failing", async () => {
  // A database that has not taken the migration must still answer.
  const client = rpcClient([], { fail: true });
  const result = await aggregateResource(
    unitsResource, new URLSearchParams(),
    { groupBy: null, groupValues: [], metric: "count", measure: null },
    client,
  );
  assert.equal(result.engine, "scan", "degrades instead of breaking");
});

test("a client with no rpc at all still works", async () => {
  const result = await aggregateResource(
    unitsResource, new URLSearchParams(),
    { groupBy: "occupancy_status", groupValues: ["Occupied"], metric: "count", measure: null },
    memClient({ resman_units: [{ resman_unit_id: "u", occupancy_status: "Occupied" }] }),
  );
  assert.equal(result.engine, "scan");
  assert.equal(result.buckets[0].count, 1);
});

// -------------------------------------------------------- server row cap ---

/**
 * A client that enforces PostgREST's server-side 1,000-row ceiling: it honours
 * `.range()` but never returns more than a page, whatever `.limit()` asks for.
 */
function cappedClient(tables, pageCap = 1000) {
  const build = (rows, state) => ({
    eq: (c, v) => build(rows.filter((r) => String(r[c]) === String(v)), state),
    is: () => build(rows, state),
    not: (c) => build(rows.filter((r) => r[c] !== null && r[c] !== undefined), state),
    gte: (c, v) => build(rows.filter((r) => r[c] != null && String(r[c]) >= String(v)), state),
    lte: (c, v) => build(rows.filter((r) => r[c] != null && String(r[c]) <= String(v)), state),
    lt: (c, v) => build(rows.filter((r) => r[c] != null && String(r[c]) < String(v)), state),
    or: () => build(rows, state),
    in: (c, keys) => build(rows.filter((r) => keys.includes(String(r[c]))), state),
    order: (c) => build([...rows].sort((a, b) => String(a[c]).localeCompare(String(b[c]))), state),
    limit: (n) => build(rows, { ...state, limit: n }),
    range: (from, to) => build(rows, { ...state, from, to }),
    maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    then(resolve) {
      let out = rows;
      if (state.from !== undefined) out = out.slice(state.from, state.to + 1);
      else if (state.limit !== undefined) out = out.slice(0, state.limit);
      // The ceiling the real server applies regardless of what was asked for.
      out = out.slice(0, pageCap);
      return resolve({ data: state.head ? null : out, error: null, count: rows.length });
    },
  });
  return {
    from: (t) => ({ select: (_c, opts) => build(tables[t] ?? [], { head: Boolean(opts && opts.head) }) }),
  };
}

test("a measure aggregate pages past the server's 1,000-row response cap", async () => {
  // PostgREST caps a response at 1,000 rows however large a .limit() is. A
  // single-shot scan therefore summed a PREFIX of the table and reported
  // truncated:false, because 1,000 was under the 20,000 client-side cap.
  const rows = Array.from({ length: 2_885 }, (_, i) => ({
    id: String(i).padStart(5, "0"),
    payment_method: "Card",
    amount: 1,
  }));
  const result = await aggregateResource(
    mlgwPaymentsResource,
    new URLSearchParams(),
    { groupBy: null, groupValues: [], metric: "sum", measure: "amount" },
    cappedClient({ mlgw_payments: rows }),
  );
  assert.equal(result.scanned, 2_885, "every row is read, not just the first page");
  assert.equal(result.buckets[0].value, 2_885, "the sum covers the whole table");
  assert.equal(result.truncated, false);
});

test("a scan that genuinely exceeds the cap still reports truncated", async () => {
  const rows = Array.from({ length: 20_500 }, (_, i) => ({
    id: String(i).padStart(6, "0"),
    payment_method: "Card",
    amount: 1,
  }));
  const result = await aggregateResource(
    mlgwPaymentsResource,
    new URLSearchParams(),
    { groupBy: null, groupValues: [], metric: "sum", measure: "amount" },
    cappedClient({ mlgw_payments: rows }),
  );
  assert.equal(result.scanned, 20_000, "stops at the client-side cap");
  assert.equal(result.truncated, true, "and says so, rather than implying completeness");
});

// ------------------------------------------------ sampled-domain backstop ---

test("a group value outside the sampled domain lands in (other), not nowhere", async () => {
  // describe_resource learns group values from a 5,000-row SAMPLE. Before the
  // reconciliation, a value the sample missed simply had no bucket — and a
  // missing bucket reads exactly like a genuine zero.
  const units = [
    ...Array.from({ length: 5 }, () => ({ resman_unit_id: "u", occupancy_status: "Occupied" })),
    ...Array.from({ length: 3 }, () => ({ resman_unit_id: "u", occupancy_status: "Vacant" })),
    ...Array.from({ length: 2 }, () => ({ resman_unit_id: "u", occupancy_status: "Notice" })),
  ];
  const result = await aggregateResource(
    unitsResource,
    new URLSearchParams(),
    // "Notice" deliberately absent — this is what a sample that missed it looks like.
    { groupBy: "occupancy_status", groupValues: ["Occupied", "Vacant"], metric: "count", measure: null },
    memClient({ resman_units: units }),
  );
  const byGroup = Object.fromEntries(result.buckets.map((b) => [b.group, b.count]));
  assert.equal(byGroup.Occupied, 5);
  assert.equal(byGroup.Vacant, 3);
  assert.equal(byGroup["(other)"], 2, "the unaccounted rows are surfaced, not lost");
  assert.equal(result.total, 10, "buckets reconcile against the true total");
});

test("no (other) bucket appears when the domain accounts for every row", async () => {
  const units = [
    { resman_unit_id: "u", occupancy_status: "Occupied" },
    { resman_unit_id: "u", occupancy_status: "Vacant" },
  ];
  const result = await aggregateResource(
    unitsResource,
    new URLSearchParams(),
    { groupBy: "occupancy_status", groupValues: ["Occupied", "Vacant"], metric: "count", measure: null },
    memClient({ resman_units: units }),
  );
  assert.ok(!result.buckets.some((b) => b.group === "(other)"));
});

// ------------------------------------------------------ period bucketing ---

test("a count aggregate buckets by month in chronological order", async () => {
  const rows = [
    { resman_ledger_entry_id: "1", date: "2026-01-05", charges: 100 },
    { resman_ledger_entry_id: "2", date: "2026-01-20", charges: 50 },
    { resman_ledger_entry_id: "3", date: "2026-03-02", charges: 25 },
  ];
  const result = await aggregateResource(
    transactionsResource,
    new URLSearchParams(),
    {
      groupBy: null, groupValues: [], metric: "count", measure: null,
      period: { column: "date", kind: "date", interval: "month", timezone: "America/Chicago" },
    },
    memClient({ resman_transactions: rows }),
  );
  assert.deepEqual(
    result.buckets.map((b) => [b.period, b.count]),
    [["2026-01", 2], ["2026-02", 0], ["2026-03", 1]],
    "February is present with a zero — a gap in a series is information",
  );
  assert.equal(result.period.interval, "month");
  assert.equal(result.period.timezone, null, "a DATE column reports no timezone, because none was applied");
});

test("a measure aggregate buckets by month and excludes nulls", async () => {
  const rows = [
    { resman_ledger_entry_id: "1", date: "2026-01-05", charges: 100 },
    { resman_ledger_entry_id: "2", date: "2026-01-20", charges: null },
    { resman_ledger_entry_id: "3", date: "2026-02-02", charges: 40 },
  ];
  const result = await aggregateResource(
    transactionsResource,
    new URLSearchParams(),
    {
      groupBy: null, groupValues: [], metric: "sum", measure: "charges",
      period: { column: "date", kind: "date", interval: "month", timezone: "America/Chicago" },
    },
    memClient({ resman_transactions: rows }),
  );
  assert.deepEqual(result.buckets.map((b) => [b.period, b.value]), [["2026-01", 100], ["2026-02", 40]]);
});

test("period only accepts a DECLARED period column", async () => {
  const res = await handleMcpMessage(
    {
      id: 20, method: "tools/call",
      params: { name: "aggregate_resource", arguments: { resource: "units", period: { column: "created_at" } } },
    },
    { staff: staff(["*"]), client: fakeClient() },
  );
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /not a period column on units/);
});

test("period rejects an unknown interval and an unknown timezone", async () => {
  const bad = async (period) =>
    (await handleMcpMessage(
      { id: 21, method: "tools/call", params: { name: "aggregate_resource", arguments: { resource: "work-orders", period } } },
      { staff: staff(["*"]), client: fakeClient() },
    )).result.content[0].text;
  assert.match(await bad({ column: "reported", interval: "fortnight" }), /Unknown interval/);
  assert.match(await bad({ column: "reported", timezone: "Mars/Olympus" }), /Unknown timezone/);
});

// ------------------------------------------------------ empty vs filtered ---

test("an empty resource says so instead of returning a bare empty list", async () => {
  // entry_logs is empty in production, so "who came through the gate last
  // night" returns [] — which reads as "nobody came through" rather than
  // "the scanners have never been used".
  const res = await handleMcpMessage(
    { id: 22, method: "tools/call", params: { name: "query_resource", arguments: { resource: "entry-logs" } } },
    { staff: staff(["*"]), client: memClient({ entry_logs: [] }) },
  );
  const payload = JSON.parse(res.result.content[0].text);
  assert.deepEqual(payload.data, []);
  assert.match(payload.note, /EMPTY/);
  assert.match(payload.note, /not a filtered-out result/);
});

test("a table with rows but no matches gets no emptiness note", async () => {
  const res = await handleMcpMessage(
    {
      id: 23, method: "tools/call",
      params: { name: "query_resource", arguments: { resource: "entry-logs", filters: { entry_type: "guest" } } },
    },
    { staff: staff(["*"]), client: memClient({ entry_logs: [{ id: "1", entry_type: "resident" }] }) },
  );
  const payload = JSON.parse(res.result.content[0].text);
  assert.deepEqual(payload.data, []);
  assert.equal(payload.note, undefined, "a genuine no-match must not be mislabelled as an empty table");
});

// ------------------------------------------------------------- history ----

test("property-snapshots is the only resource that can answer a trend question", () => {
  // The ResMan mirror upserts CURRENT state, so no unit/lease/work-order table
  // can answer "how has vacancy moved". If this resource ever loses its period
  // declaration, that whole class of question silently becomes unanswerable
  // again — which is the state it was in for two years.
  const snapshots = RESMAN_RESOURCES.find((r) => r.name === "property-snapshots");
  assert.ok(snapshots, "property-snapshots must stay registered");
  assert.ok(Object.keys(snapshots.periods).includes("snapshot_date"));
  assert.ok(snapshots.measures.includes("occupancy_pct"));
  assert.ok(snapshots.measures.includes("balance_total"));
  assert.ok(snapshots.groupable.includes("source"), "source must be groupable to separate backfill from nightly");
  assert.equal(snapshots.filters.source, "source", "and filterable, which is how the sparse-coverage trap is avoided");
});

test("property-snapshots warns about its uneven coverage", () => {
  // 730 of 736 rows are occupancy-only; the financial columns start 2026-07-21.
  // An average of balance_total over "two years" really covers about nine days.
  const snapshots = RESMAN_RESOURCES.find((r) => r.name === "property-snapshots");
  const joined = snapshots.notes.join(" ");
  assert.match(joined, /COVERAGE IS UNEVEN/);
  assert.match(joined, /nightly/, "the note must name the filter that fixes it");
});

test("resources carry their caveats and describe_resource leads with them", async () => {
  const res = await handleMcpMessage(
    { id: 30, method: "tools/call", params: { name: "describe_resource", arguments: { resource: "units" } } },
    { staff: staff(["*"]), client: memClient({ resman_units: [{ resman_unit_id: "u1", occupancy_status: "Occupied" }] }) },
  );
  const payload = JSON.parse(res.result.content[0].text);
  assert.ok(Array.isArray(payload.notes_before_you_report));
  assert.match(payload.notes_before_you_report.join(" "), /disagree by 60 units/);
});

test("the traps sheet names the history resource", async () => {
  const res = await handleMcpMessage(
    { id: 31, method: "resources/read", params: { uri: "emberly://data-traps" } },
    { staff: staff(["*"]), client: fakeClient() },
  );
  assert.match(res.result.contents[0].text, /The mirror has no history/);
});

test("occupancy_trend is offered only with the snapshots scope", async () => {
  const withIt = await handleMcpMessage(
    { id: 32, method: "prompts/list" }, { staff: staff(["property-snapshots"]), client: fakeClient() },
  );
  assert.deepEqual(withIt.result.prompts.map((p) => p.name), ["occupancy_trend"]);

  const without = await handleMcpMessage(
    { id: 33, method: "prompts/list" }, { staff: staff(["units", "leases"]), client: fakeClient() },
  );
  assert.ok(!without.result.prompts.some((p) => p.name === "occupancy_trend"));
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

// ------------------------------------------------------ response budgeting ---

/**
 * A page of wide rows is the one place this server used to quietly do the
 * expensive thing: units at the documented max limit measured 267 KB — about
 * 65k tokens, a third of a context window, for one call.
 */
test("a wide page is trimmed to the byte budget and says how to get more", async () => {
  const wide = Array.from({ length: 200 }, (_, i) => ({
    resman_unit_id: `u${i}`,
    number: `unit-${i}`,
    notes: "x".repeat(1200), // ~1.3 KB/row, matching live units
  }));
  const res = await handleMcpMessage(
    { id: 40, method: "tools/call", params: { name: "query_resource", arguments: { resource: "units", limit: 200 } } },
    { staff: staff(["*"]), client: memClient({ resman_units: wide }) },
  );
  const payload = JSON.parse(res.result.content[0].text);
  assert.ok(payload.data.length < 200, "the page shrank");
  assert.ok(payload.data.length > 0, "but did not vanish");
  assert.ok(res.result.content[0].text.length < 60_000, "response stays inside the budget");
  assert.match(payload.note, /trimmed/);
  assert.match(payload.note, /columns/, "the note names the fix");
  assert.equal(payload.pagination.hasMore, true, "paging stays honest");
});

test("a narrow page is returned whole, with no note", async () => {
  const narrow = Array.from({ length: 200 }, (_, i) => ({ resman_unit_id: `u${i}`, number: `${i}` }));
  const res = await handleMcpMessage(
    { id: 41, method: "tools/call", params: { name: "query_resource", arguments: { resource: "units", limit: 200 } } },
    { staff: staff(["*"]), client: memClient({ resman_units: narrow }) },
  );
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.data.length, 200);
  assert.equal(payload.note, undefined, "nothing to warn about");
});

test("a single row larger than the whole budget is still returned", async () => {
  // Returning nothing would look like an empty result, which is a different
  // and worse claim than "this row is enormous".
  const huge = [{ resman_unit_id: "u1", notes: "x".repeat(60_000) }];
  const res = await handleMcpMessage(
    { id: 42, method: "tools/call", params: { name: "query_resource", arguments: { resource: "units" } } },
    { staff: staff(["*"]), client: memClient({ resman_units: huge }) },
  );
  assert.equal(JSON.parse(res.result.content[0].text).data.length, 1);
});

// ------------------------------------------------------- canonical scopes ---

test("scope narrows in addition to the caller's filters, never instead of them", async () => {
  const client = rpcClient([{ grp: null, period: null, n: 876, val: null }]);
  await aggregateResource(
    unitsResource,
    new URLSearchParams({ occupancy_status: "Occupied" }),
    { groupBy: null, groupValues: [], metric: "count", measure: null, scope: null },
    client,
  );
  // Without a scope: just the caller's filter.
  assert.deepEqual(client.calls[0].args.p_filters, [{ col: "occupancy_status", op: "eq", val: "Occupied" }]);

  const scoped = rpcClient([{ grp: null, period: null, n: 508, val: null }]);
  const params = new URLSearchParams({ occupancy_status: "Occupied" });
  params.set("scope", "rentable");
  await aggregateResource(
    unitsResource, params,
    { groupBy: null, groupValues: [], metric: "count", measure: null },
    scoped,
  );
  // `vals` rides along for the `in` operator and is null for the rest.
  assert.deepEqual(scoped.calls[0].args.p_filters, [
    { col: "occupancy_status", op: "eq", val: "Occupied" },
    { col: "holding_unit", op: "eq", val: "false", vals: null },
    { col: "excluded_from_occupancy", op: "eq", val: "false", vals: null },
  ], "the caller's filter survives and the scope is added");
});

test("a scope's OR group is sent as its own clause, not merged into the ANDs", async () => {
  // "delinquent" is a balance OR a stated reason. Flattening it into the AND
  // list would silently mean "a balance AND a reason", which is a much smaller
  // and wrong set.
  const client = rpcClient([]);
  const params = new URLSearchParams();
  params.set("scope", "delinquent");
  await aggregateResource(
    unitsResource, params,
    { groupBy: null, groupValues: [], metric: "count", measure: null },
    client,
  );
  const { p_filters, p_any } = client.calls[0].args;
  assert.deepEqual(p_filters.map((f) => f.col), ["holding_unit", "excluded_from_occupancy"]);
  assert.deepEqual(p_any.map((f) => [f.col, f.op]), [["balance", "gte"], ["delinquency_reason", "neq"]]);
});

test("an 'in' scope carries its value set", async () => {
  const client = rpcClient([]);
  const params = new URLSearchParams();
  params.set("scope", "open");
  await aggregateResource(
    workOrdersResource, params,
    { groupBy: null, groupValues: [], metric: "count", measure: null },
    client,
  );
  const [predicate] = client.calls[0].args.p_filters;
  assert.equal(predicate.op, "in");
  assert.ok(predicate.vals.includes("Not Started"));
  assert.ok(!predicate.vals.includes("Completed"), "a terminal status is not open");
});

test("an undeclared scope is refused rather than ignored", async () => {
  // Ignoring it would answer a WIDER question than the one asked — the exact
  // failure the scopes exist to prevent.
  const res = await handleMcpMessage(
    { id: 43, method: "tools/call", params: { name: "aggregate_resource", arguments: { resource: "units", scope: "made_up" } } },
    { staff: staff(["*"]), client: fakeClient() },
  );
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /not a scope on units. Available: rentable, occupied, vacant/);
});

test("units and unit-snapshots agree on what rentable means", () => {
  // A historical occupancy rate must be computed the same way as today's, or
  // the series compares two different things.
  const snapshots = RESMAN_RESOURCES.find((r) => r.name === "unit-snapshots");
  const now = new Set(unitsResource.scopes.rentable.filters.map((f) => `${f.column}:${f.value}`));
  const then = new Set(snapshots.scopes.rentable.filters.map((f) => `${f.column}:${f.value}`));
  assert.deepEqual([...now].sort(), [...then].sort());
});

test("every declared scope filters on columns the resource actually queries", () => {
  for (const resource of RESMAN_RESOURCES) {
    for (const [name, scope] of Object.entries(resource.scopes)) {
      assert.ok(scope.description.length > 20, `${resource.name}.${name} needs a real description`);
      for (const filter of scope.filters) {
        assert.ok(
          resource.selectColumns.includes(filter.column),
          `${resource.name}.${name} filters on ${filter.column}, which the resource never queries`,
        );
      }
    }
  }
});
