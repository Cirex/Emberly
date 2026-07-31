# MCP Tools

What the Emberly MCP server can answer, and how to ask. For connecting a client, see
[[MCP Server Setup]].

The server is **read-only** and exposes six tools over the ResMan + MLGW mirror. The design
rule throughout: **you name a capability, never a column or an expression**. Every searchable,
groupable, sortable and joinable column is declared per-resource in
`apps/web/lib/resman-resources.ts`. Anything absent from those lists is unreachable however
the request is phrased — which is what lets the surface be expressive without becoming
arbitrary SQL over resident data.

---

## The six tools

| Tool | Use it for |
|---|---|
| `list_resources` | What exists, and what each resource can do. Start here. |
| `describe_resource` | One resource in depth — columns, capabilities, **the values its columns actually hold**, row count, freshness. |
| `query_resource` | Rows: filters, ranges, substring search, sort, projection, paging. |
| `aggregate_resource` | Counting and totalling. One call instead of paging a table. |
| `get_resource` | One row by id. |
| `related_resource` | Walk a declared relation to another resource. |

### The order that works

1. `list_resources` — find the resource.
2. `describe_resource` — **learn the values before you filter.** This is the step people skip,
   and skipping it is how you end up filtering on a status the property has never used, getting
   zero rows, and reporting "none" — which reads exactly like a real zero.
3. `query_resource` / `aggregate_resource` — ask the question.

---

## Counting: use `aggregate_resource`, not paging

`count` is **exact and transfers no rows** — it runs a `HEAD` count per group. Use it for any
"how many" question.

```json
{ "resource": "units", "group_by": "occupancy_status", "metric": "count" }
```
```json
{ "buckets": [ { "group": "Occupied", "count": 503 },
               { "group": "Vacant",   "count": 328 },
               { "group": "Notice",   "count":  60 } ], "scanned": 0 }
```

`sum` / `avg` / `min` / `max` need the values, so they scan up to **20,000 rows** and set
`truncated: true` if they hit that ceiling. **Check that flag.** A truncated average is not a
smaller average — it is a wrong one.

Nulls are excluded, as in SQL. A unit with no `market_rent` does not count as £0.

Filters, ranges and search all apply to aggregates exactly as they do to queries:

```json
{ "resource": "units", "group_by": "resman_building_id", "metric": "avg",
  "measure": "market_rent", "filters": { "occupancy_status": "Occupied" } }
```

---

## Searching

`search` matches case-insensitively across the resource's declared searchable columns,
minimum two characters:

```json
{ "resource": "work-orders", "search": "comcast", "filters": { "status": "Not Started" } }
```

Substring search is a **full scan** — a leading wildcard defeats every index — so the
searchable list is deliberately short, and you should pair a search on a large table with a
filter or a range.

**Residents are searchable by name only.** `email` and `phone_numbers` are queried to derive
`has_email` / `has_phone` and then dropped from the response; making them searchable would leak
the withheld value by inference (probe until a match narrows it to one person).

---

## Ranges, sort, projection

Ranges are inclusive, addressed as `<param>_from` / `<param>_to`:

```json
{ "resource": "work-orders", "ranges": { "reported_from": "2026-01-01", "reported_to": "2026-02-01" } }
```

`columns` trims the response to what you need — worth doing, since a 200-row page of 40-column
units is a lot of context spent on fields you are not reading:

```json
{ "resource": "units", "columns": ["number", "occupancy_status", "market_rent"], "sort": "market_rent", "dir": "desc" }
```

A projection is **intersected** with the resource's public columns. Naming a withheld column
gets you nothing, not the column. A typo degrades to the full row rather than an empty one.

---

## Joins

`related_resource` walks a **declared** one-hop relation. `describe_resource` lists what each
resource has. Multi-hop means repeated calls — by design, so every hop is visible and scoped.

```json
{ "resource": "units", "id": "<unit-id>", "relation": "leases" }
```

The relation's target is scope-checked **independently**: reaching residents via a lease does
not bypass a token that lacks the `residents` scope.

---

## Traps in this data

These are real, currently true, and each one has produced a confidently wrong answer.

### `occupied` vs `occupancy_status` — they differ by 60 units

Both are correct; they answer different questions.

- **`occupied`** (boolean) — is anyone living there? **563** units.
- **`occupancy_status`** (three-state) — `Occupied` / `Vacant` / `Notice`. **503** are `Occupied`.

The 60-unit gap is the `Notice` bucket: 57 Under Eviction and 3 Notice to Vacate. Those
households are **still in the apartment**, so they are `occupied = true` but not
`occupancy_status = 'Occupied'`.

**Use `occupied` for anything physical** — parking, utilities, access control, occupancy load.
**Use `occupancy_status` for leasing and reporting**, where Notice needs to be its own state.
Asking "how many units are occupied" and grouping by `occupancy_status` undercounts by 60.

### `units.lease_status` is narrower than `leases.status`

`units.lease_status` comes from the All-Units report and has eight values. `leases.status`
is the full lifecycle and has twelve — including **`Evicted` and `Former`, which never appear
on the units table at all**. If you are asking about terminal lease states, you must go to the
`leases` resource.

The two also **disagree on 14 units** right now, because they come from different ResMan
reports. One unit has a `Former` lease still attached as its current lease while All-Units
calls that lease `Current`. Treat a lease-status question answered from `units` alone as
approximate.

### `synced_at` is not `updated_at`

- **`synced_at`** — the scraper last *saw* this row.
- **`updated_at`** — this row last *changed*.

`describe_resource` reports `last_synced_at` so you can say how stale an answer is. They are
far apart when nothing is changing, which is normal, not an outage.

### Free text is not a category

`title`, `notes` and `completion_notes` are not groupable, on purpose — grouping by free text
is a full table dump wearing an aggregate's clothes. Search them instead.

### Manual fields are sparse

Vehicle registration, `holding_unit` and similar are entered by hand in ResMan. A blank means
**nobody typed it**, not that the answer is no. 41% of occupied units have no vehicle on
file; that is a data-entry rate, not a car-ownership rate. Say which you are reporting.

---

## Scopes

A token reads only the resources in its scope list. **An empty list grants nothing** — use
`*` for everything. See [[MCP Server Setup]].

Every tool call is written to `access_token_audit_log` with the tool, resource and arguments.

---

## Adding a capability

All of it is declarative. To make a column searchable, groupable, sortable or joinable, add it
to the resource in `apps/web/lib/resman-resources.ts`:

```ts
searchable: ["title", "notes"],          // full scan — keep short
ranges:     { reported: "date_reported" },
groupable:  ["status", "priority"],      // LOW-CARDINALITY only
measures:   ["market_rent", "balance"],  // numeric only
sortable:   ["date_reported", "number"],
relations:  [{ name: "unit", resource: "units",
               localColumn: "resman_unit_id", foreignColumn: "resman_unit_id", kind: "one" }],
```

Two rules the tests enforce (`apps/web/tests/mcp-capabilities.test.js`):

- **Never make a withheld column searchable.** Matching on a value leaks it even when the
  column is not returned.
- **Never make a name or free-text column groupable.** Grouping by a person's name turns an
  aggregate into an enumeration of people.
