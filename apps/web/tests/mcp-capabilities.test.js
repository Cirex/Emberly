const assert = require("node:assert/strict");
const test = require("node:test");

const {
  resolveSearch,
  resolveRanges,
  resolveSort,
  resolveProjection,
  aggregateResource,
} = require("../lib/resman-api");
const {
  unitsResource,
  workOrdersResource,
  residentsResource,
  RESMAN_RESOURCES,
} = require("../lib/resman-resources");

/**
 * The MCP surface is expressive by DECLARATION: a caller names a capability
 * (search, group, sort, join) and the resource decides whether that column
 * participates. These tests pin the allowlists, because the failure mode is
 * silent — a column that leaks into `searchable` is queryable forever after,
 * and nobody notices until it matters.
 */

const params = (obj) => new URLSearchParams(obj);

// ---------------------------------------------------------------- search ---

test("search builds an OR across only the declared searchable columns", () => {
  const s = resolveSearch(workOrdersResource, params({ q: "comcast" }));
  assert.ok(s);
  assert.deepEqual([...s.columns], [...workOrdersResource.searchable]);
  for (const column of workOrdersResource.searchable) {
    assert.match(s.expression, new RegExp(`${column}\\.ilike\\.\\*comcast\\*`));
  }
});

test("search is refused below two characters", () => {
  // `%a%` matches nearly every row: a full scan that also returns everything.
  assert.equal(resolveSearch(workOrdersResource, params({ q: "a" })), null);
  assert.equal(resolveSearch(workOrdersResource, params({ q: " " })), null);
  assert.ok(resolveSearch(workOrdersResource, params({ q: "ac" })));
});

test("search strips the characters that would break out of the OR expression", () => {
  // `,` and `)` both terminate a clause in a PostgREST or= list.
  const s = resolveSearch(workOrdersResource, params({ q: "a,b)c(d*e" }));
  assert.ok(s);
  assert.equal(s.term, "abcde");
  assert.ok(!s.expression.includes("),"), "no clause break survives");
});

test("a resource with nothing searchable cannot be searched", () => {
  const bare = RESMAN_RESOURCES.find((r) => r.searchable.length === 0);
  assert.ok(bare, "expected at least one resource with no searchable columns");
  assert.equal(resolveSearch(bare, params({ q: "anything" })), null);
});

test("residents are searchable by name but NEVER by the withheld contact columns", () => {
  // email / phone_numbers are queried to derive has_email / has_phone and then
  // dropped from the response. Searching them would leak the hidden value by
  // inference — probe until a match narrows it to one person.
  assert.deepEqual([...residentsResource.searchable], ["first_name", "last_name"]);
  const s = resolveSearch(residentsResource, params({ q: "smith" }));
  assert.ok(!s.expression.includes("email"));
  assert.ok(!s.expression.includes("phone"));
});

// ---------------------------------------------------------------- ranges ---

test("ranges resolve inclusive from/to bounds onto the declared column", () => {
  const bounds = resolveRanges(workOrdersResource, params({ reported_from: "2026-01-01", reported_to: "2026-02-01" }));
  assert.deepEqual(bounds, [
    { column: "date_reported", op: "gte", value: "2026-01-01" },
    { column: "date_reported", op: "lte", value: "2026-02-01" },
  ]);
});

test("an undeclared range param is ignored", () => {
  assert.deepEqual(resolveRanges(workOrdersResource, params({ salary_from: "1" })), []);
});

test("a malformed bound is dropped rather than passed to Postgres", () => {
  assert.deepEqual(resolveRanges(workOrdersResource, params({ reported_from: "last tuesday" })), []);
  assert.equal(resolveRanges(unitsResource, params({ market_rent_from: "900" })).length, 1);
});

// ------------------------------------------------------------------ sort ---

test("sort is restricted to the sortable allowlist", () => {
  assert.deepEqual(resolveSort(unitsResource, params({ sort: "market_rent", dir: "desc" })), {
    column: "market_rent",
    ascending: false,
  });
  // Not in units.sortable — falls back to the resource's default order.
  assert.equal(resolveSort(unitsResource, params({ sort: "tenant_names" })), null);
  assert.equal(resolveSort(unitsResource, params({ sort: "notes" })), null);
});

// ------------------------------------------------------------ projection ---

test("projection intersects with public columns and never unions", () => {
  const kept = resolveProjection(unitsResource, params({ columns: "number,market_rent,resman_unit_id" }));
  assert.deepEqual([...kept], ["resman_unit_id", "number", "market_rent"]);
});

test("naming a withheld column yields nothing, not the column", () => {
  // `email` is queried on residents but withheld from publicColumns.
  const kept = resolveProjection(residentsResource, params({ columns: "email,phone_numbers" }));
  assert.equal(kept, null, "no valid column survives -> full public row, never the hidden one");
});

test("a typo degrades to the full row rather than an empty one", () => {
  assert.equal(resolveProjection(unitsResource, params({ columns: "numbr" })), null);
});

// ------------------------------------------------------------- aggregate ---

/** Minimal client recording what the aggregate asked the database for. */
function aggClient({ countsByValue = {}, rows = [] } = {}) {
  const calls = [];
  const builder = (state) => ({
    eq(column, value) {
      return builder({ ...state, eqs: [...state.eqs, [column, value]] });
    },
    is(column, value) {
      return builder({ ...state, eqs: [...state.eqs, [column, value]] });
    },
    gte() { return builder(state); },
    lte() { return builder(state); },
    or() { return builder(state); },
    limit() { return builder(state); },
    then(resolve) {
      calls.push(state);
      if (state.head) {
        const bucket = state.eqs.find(([c]) => c === state.groupColumn);
        const key = bucket ? String(bucket[1]) : "__all__";
        return resolve({ count: countsByValue[key] ?? 0, error: null });
      }
      return resolve({ data: rows, error: null });
    },
  });
  return {
    calls,
    from() {
      return {
        select(_cols, opts) {
          return builder({ eqs: [], head: Boolean(opts && opts.head), groupColumn: null });
        },
      };
    },
  };
}

test("count aggregates transfer no rows and stay exact", async () => {
  const client = aggClient({ countsByValue: { Occupied: 503, Vacant: 328, Notice: 60 } });
  // Teach the recorder which column is the group so it can answer per bucket.
  const from = client.from;
  client.from = (t) => {
    const table = from.call(client, t);
    const select = table.select;
    table.select = (cols, opts) => {
      const b = select.call(table, cols, opts);
      b.eq = ((orig) => (column, value) => {
        const next = orig.call(b, column, value);
        next.then = (resolve) =>
          resolve({ count: { Occupied: 503, Vacant: 328, Notice: 60 }[String(value)] ?? 0, error: null });
        return next;
      })(b.eq);
      return b;
    };
    return table;
  };

  const result = await aggregateResource(
    unitsResource,
    new URLSearchParams(),
    { groupBy: "occupancy_status", groupValues: ["Occupied", "Vacant", "Notice"], metric: "count", measure: null },
    client,
  );

  assert.equal(result.metric, "count");
  assert.equal(result.scanned, 0, "count reads no rows");
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.buckets.map((b) => [b.group, b.count]),
    [["Occupied", 503], ["Vacant", 328], ["Notice", 60]],
    "sorted by count, descending",
  );
});

test("measure aggregates compute per group and skip nulls like SQL", async () => {
  const rows = [
    { occupancy_status: "Occupied", market_rent: 1000 },
    { occupancy_status: "Occupied", market_rent: 1200 },
    { occupancy_status: "Vacant", market_rent: 900 },
    { occupancy_status: "Vacant", market_rent: null }, // must not drag the average down
  ];
  const result = await aggregateResource(
    unitsResource,
    new URLSearchParams(),
    { groupBy: "occupancy_status", groupValues: [], metric: "avg", measure: "market_rent" },
    aggClient({ rows }),
  );
  const byGroup = Object.fromEntries(result.buckets.map((b) => [b.group, b]));
  assert.equal(byGroup.Occupied.value, 1100);
  assert.equal(byGroup.Vacant.value, 900);
  assert.equal(byGroup.Vacant.count, 1, "the null row is not counted");
});

test("a measure aggregate reports truncation instead of quietly lying", async () => {
  const rows = Array.from({ length: 20_000 }, () => ({ occupancy_status: "Occupied", market_rent: 1 }));
  const result = await aggregateResource(
    unitsResource,
    new URLSearchParams(),
    { groupBy: "occupancy_status", groupValues: [], metric: "sum", measure: "market_rent" },
    aggClient({ rows }),
  );
  assert.equal(result.truncated, true, "hitting the scan cap must be visible to the caller");
});

// ------------------------------------------------------------- relations ---

test("every declared relation points at a real resource and a filterable column", () => {
  const byName = new Map(RESMAN_RESOURCES.map((r) => [r.name, r]));
  for (const resource of RESMAN_RESOURCES) {
    for (const relation of resource.relations) {
      const target = byName.get(relation.resource);
      assert.ok(target, `${resource.name}.${relation.name} -> unknown resource "${relation.resource}"`);
      assert.ok(
        resource.selectColumns.includes(relation.localColumn),
        `${resource.name}.${relation.name} reads ${relation.localColumn}, which the resource never queries`,
      );
      if (relation.kind === "many") {
        // A "many" hop is served through the target's own filter map, so the
        // foreign column has to be exposed there or the traversal cannot run.
        const exposed = Object.values(target.filters).includes(relation.foreignColumn);
        assert.ok(
          exposed,
          `${resource.name}.${relation.name} needs ${target.name} to filter on ${relation.foreignColumn}`,
        );
      }
    }
  }
});

test("groupable columns never include free text or a person's name", () => {
  // Grouping by a name turns an aggregate into an enumeration; grouping by free
  // text is a full dump wearing an aggregate's clothes.
  const banned = [
    "title", "notes", "completion_notes", "first_name", "last_name",
    // Both spellings: `tenant_names` on units, `tenant_name` on entry_logs.
    // Grouping the gate log by resident name ranks people by how often they
    // come and go, which is surveillance wearing an aggregate's clothes.
    "tenant_names", "tenant_name", "guest_name",
    "ledger_description", "service_address", "unit_address",
  ];
  for (const resource of RESMAN_RESOURCES) {
    for (const column of resource.groupable) {
      assert.ok(!banned.includes(column), `${resource.name} must not be groupable by ${column}`);
    }
  }
});
