# MCP Tools

What the Emberly MCP server can answer, and how to ask. For connecting a client, see
[[MCP Server Setup]].

The server is **read-only** and exposes nine tools, five prompts and two attachable resources
over the ResMan + MLGW mirror. The design rule throughout: **you name a capability, never a
column or an expression**. Every searchable, groupable, sortable and joinable column is
declared per-resource in `apps/web/lib/resman-resources.ts`. Anything absent from those lists
is unreachable however the request is phrased — which is what lets the surface be expressive
without becoming arbitrary SQL over resident data.

All sixteen resources declare capabilities. (Through v0.1 only five did; the MLGW and
gate-log tables were list-only, which made utility spend and gate activity unaskable.)

---

## The nine tools

| Tool | Use it for |
|---|---|
| `list_resources` | What exists, and what each resource can do. Start here. |
| `describe_resource` | One resource in depth — columns, capabilities, **the values its columns actually hold**, row count, freshness. |
| `query_resource` | Rows: filters, ranges, substring search, sort, projection, paging. |
| `aggregate_resource` | Counting and totalling within one resource, optionally **bucketed over time**. |
| `aggregate_related` | Totalling one resource **grouped by another's** attribute — charges by building, work orders by occupancy. |
| `get_resource` | One row by id. |
| `related_resource` | Walk a declared relation to another resource. |
| `detect_anomalies` | Which entities moved most against **their own** history. |
| `data_freshness` | How current each resource is, and which have stopped syncing. |

### The order that works

1. `list_resources` — find the resource.
2. `describe_resource` — **learn the values before you filter.** This is the step people skip,
   and skipping it is how you end up filtering on a status the property has never used, getting
   zero rows, and reporting "none" — which reads exactly like a real zero.
3. `query_resource` / `aggregate_resource` — ask the question.

Clients that support MCP **prompts** can skip straight to a canned analysis; see
[Prompts](#prompts) below.

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

Counts reconcile against the true row total and report it as `total`. Anything the group domain
did not account for appears as an explicit **`(other)`** bucket — see
[Sampled group domains](#sampled-group-domains).

Nulls are excluded, as in SQL. A unit with no `market_rent` does not count as £0.

Filters, ranges and search all apply to aggregates exactly as they do to queries:

```json
{ "resource": "units", "group_by": "resman_building_id", "metric": "avg",
  "measure": "market_rent", "filters": { "occupancy_status": "Occupied" } }
```

---

## Time series

`period` buckets an aggregate over a calendar interval, so a trend is one call
instead of twelve range-filtered ones:

```json
{ "resource": "mlgw/bills", "metric": "sum", "measure": "amount_due",
  "period": { "column": "bill_date", "interval": "month" } }
```

`interval` is `day` / `week` / `month` (default) / `quarter` / `year`. Weeks start Monday.
Only columns in a resource's `periods` list are bucketable — `describe_resource` lists them.

It **combines with `group_by`** to give a series per category:

```json
{ "resource": "work-orders", "metric": "count", "group_by": "status",
  "period": { "column": "reported", "interval": "month" },
  "ranges": { "reported_from": "2026-01-01", "reported_to": "2026-06-30" } }
```

Four things to know:

- **Gaps are filled with explicit zeros.** A month with no rows appears as `count: 0`, not as a
  missing bucket. A series that silently skips a month reads as continuous, which hides exactly
  the gap a trend question is asking about.
- **Buckets are half-open** — `[from, to)` — so a row on a boundary is never counted twice.
- **Windows come from your ranges** when you give them, and from the data's own min/max when you
  don't. So "spend by month" works without knowing which months exist.
- **Over 120 buckets is refused**, not clamped. `count` costs one query per bucket, and a
  silently shortened window answers a different question than the one asked.

### Dates vs timestamps

The two are bucketed differently, and the difference is declared per column:

- **`date`** — a plain calendar date (`bill_date`, `date_reported`). It carries no timezone, so
  none is applied. The response reports `timezone: null` to say so.
- **`timestamp`** — an instant (`entered_at`, `created_at`). Which day it falls on depends on
  where you stand, so these bucket in **America/Chicago**, the property's zone. A 10:30pm
  Memphis scan is `04:30Z` the next day; bucketing it in UTC files a Monday night under Tuesday.
  Override with `timezone` if you need a different one.

---

## Aggregating across a relation

`aggregate_resource` groups by a column on the resource being measured. When the grouping
attribute lives on a **different** resource — "charges by building" (charges are on
transactions, building is on units) — use `aggregate_related`.

Give the **parent** (whose column you group by), a declared `many` relation, and a measure on
the related resource:

```json
{ "resource": "units", "relation": "transactions",
  "group_by": "resman_building_id", "metric": "sum", "measure": "charges" }
```

Filters, ranges and search apply to the **parent**, which is what makes "work-order count for
*occupied* units only" expressible.

Three things to know:

- **It reads rows on both sides.** PostgREST can't express a grouped join over the mirror, so
  this scans the parent for its join keys, then scans the target in batches. Even `count` reads
  rows here. **Prefer `aggregate_resource` whenever the group column and the measure live on
  the same resource.**
- **Both caps are reported** — `truncated` and `parents_truncated`. Check them.
- **An `(unmatched)` bucket is part of the answer.** Target rows whose key matched no scanned
  parent are counted there rather than dropped. On an address-matched relation like
  `units → utility_accounts`, that number *is* "how much are we failing to attribute".

Only `many` hops work. A `one` hop is refused with a message naming the way round — grouping
a single target row by the many parents pointing at it is the question asked backwards.

The measure is validated against the **target's** allowlist. Reaching a column through a join
is not a way around the resource that owns it.

---

## History: the mirror has none, `property-snapshots` does

The ResMan mirror **upserts current state**. `units.occupancy_status`, `units.balance` and
work-order status have no past, so *"how has vacancy moved since spring"* cannot be answered
from them however it is phrased — the row simply gets overwritten each sync.

`property-snapshots` is the only history in the system: one row per day since **2024-07-21**.

```json
{ "resource": "property-snapshots", "metric": "avg", "measure": "occupancy_pct",
  "period": { "column": "snapshot_date", "interval": "quarter" } }
```
```
2024-Q3 19.57%   2025-Q1 22.18%   2025-Q3 40.58%   2026-Q1 62.03%   2026-Q3 64.44%
2024-Q4 20.09%   2025-Q2 28.83%   2025-Q4 51.69%   2026-Q2 64.60%
```

**Coverage is uneven, and this is the trap.** The occupancy columns run the full two years.
Every *other* column — `rent_roll`, `balance_total`, the aging buckets, `delinquent_units`,
`turns_in_progress`, `open_work_orders`, `utility_due` — is null across the 730 `backfill` rows
and only populated on `source = "nightly"`, which began **2026-07-21**.

So **filter to `source: "nightly"` before trending anything financial.** Nulls are excluded from
aggregates, so an unfiltered average is not *wrong* — it is computed over the six rows that have
values while appearing to span two years. Check the bucket's `count`.

Two more things it will not tell you:

- **`utility_due` is 0 on every row.** It reads as a real zero and is more likely unwired. Don't
  report it as a finding.
- **`occupancy_pct` is a third definition**, equal to neither `units.occupied` (63.2%) nor
  `units.occupancy_status = 'Occupied'` (56.5%). Say which one a figure came from.

It is still **property-level only**. Per-unit history — which units churn, how long one sat
vacant — does not exist anywhere.

---

## Anomalies

`aggregate_resource` with a `period` tells you what the property spent. `detect_anomalies`
tells you **which accounts moved**, which is what generates work. A property-level total hides
the case worth acting on — one unit's usage tripling while the portfolio barely twitches.

```json
{ "resource": "mlgw/bills", "entity": "mlgw_account_id", "measure": "amount_due",
  "period": { "column": "bill_date", "interval": "month" } }
```

Every entity is scored **against its own history**, never against the population. A large
account and a small one have different normals, and a shared baseline would flag every large
account forever. `entity` must be one of the resource's declared `entities` — high cardinality
is fine here precisely because only outliers come back.

Read the output as triage, not verdict. Each row carries the inputs that produced it —
`baseline_mean`, `baseline_stddev`, `baseline_periods` — so you can see when a dramatic
`z` rests on three flat months.

- **An entity needs 3 prior periods** (tunable via `min_baseline`) or it is not scored at all.
- **Absent ≠ zero.** An entity with no row in the focus period is skipped, not scored as a
  −100% collapse. "No bill this month" and "a bill of 0.00" are different claims.
- **A flat history falls back to percent change**, labelled `method: "pct_change"`. Zero spread
  makes a z-score infinite — true, but useless for ranking.
- **No usable rows says so explicitly.** If the measure is entirely null the report says there
  was nothing to score, because "no water anomalies" and "no water data" are different claims —
  and MLGW publishes no water readings on these accounts, so this is live.

## Freshness

`data_freshness` reports every resource's row count, last sync, last change, and **how far it
lags the freshest resource**.

Staleness is deliberately *relative*. An absolute threshold flags everything after a quiet
weekend; lagging the freshest table is what actually indicates a sync that stopped — which is
how `units` sat frozen for eleven days while `work-orders` kept updating and nothing said so.

Call it before reporting any number that has to be current.

---

## Monitoring: findings come to you

`detect_anomalies` and `data_freshness` answer when asked, and nobody was going to ask nightly.
`POST /api/cron/monitor` (bearer `CRON_SECRET`, same pattern as `/api/cron/cleanup`) runs the
anomaly watches and the freshness check and writes what it sees to the **`monitor-findings`**
resource. Schedule it after the sync pipeline.

```json
{ "resource": "monitor-findings", "filters": { "severity": "critical" } }
```

- **Open findings have `resolved_at: null`.** Rows are never deleted — a fixed problem is
  stamped resolved. So an unfiltered query mixes live and historical; filter unless you want both.
- **One row per distinct finding, not per run.** `last_seen_at` moves while it persists,
  `first_seen_at` is when it started. A finding seen for a week is one row, not seven.
- **Severity is a ranking, not a p-value.** With a handful of baseline periods a `z` of 6 is a
  sort order. Read the baseline in the summary before acting.

### Getting told

A **critical** finding pushes a digest to the manager fleet. Three rules:

- **New findings only.** `notified_at` records what has been announced, so a problem lasting a
  week alerts on the night it appeared, not seven times. A finding that resolves and later
  recurs has the stamp cleared — a returning problem is news again.
- **One digest, not one push per finding.** Fourteen criticals is one notification. Fourteen
  notifications is how an app gets muted.
- **No detail in the body.** *"14 new critical findings — 14 anomalies. Open Emberly to review."*
  An anomaly summary names a service address, and a push body renders on a locked screen in
  public. The notification says how many and how bad; the app shows what.

A send that fails leaves `notified_at` null so the next run retries. Devices Expo reports as
unregistered are deactivated rather than retried forever.

The first live run produced 34 anomalies and 9 staleness findings — and the staleness ones were
**all false positives**, which is worth knowing because both causes are now designed out:

- Creating `unit_snapshots` made it the freshest table, and a *maximum*-based reference instantly
  flagged eight healthy resources as 28h stale. The reference is now the **median** `synced_at`,
  which only moves when half the mirror moves.
- `guest-passes` was flagged at 340h behind because no new pass had been issued. Staleness is
  now judged **only on sync-backed resources** — those carrying `synced_at`. Tables written by
  user activity are reported but never flagged: quiet is not broken.

Re-running after the fix resolved all nine automatically, which is the resolution path proving
itself on real data.

---

## Prompts

Canned analyses that encode what you'd otherwise have to know. `prompts/list`:

| Prompt | Arguments |
|---|---|
| `occupancy_reconciliation` | — |
| `occupancy_trend` | `from`, `interval` |
| `work_order_aging` | `as_of` |
| `delinquency_by_building` | — |
| `utility_spend` | `from`, `to` (required) |
| `gate_activity` | `from` (required), `to` |

Each names the exact calls to make and the trap to avoid, so someone who has never seen the
schema still gets the right number — `occupancy_reconciliation` reports both occupancy views
and the 60-unit gap rather than picking one and being quietly wrong.

**A prompt is only offered when the token can read every resource it would touch**, and a
prompt out of scope reads as *unknown* rather than *forbidden* — a distinct "not authorized"
would confirm which resources exist behind a token that cannot see them.

## Attachable resources

For clients that support MCP resources, two are readable as context instead of a tool call:

| URI | What |
|---|---|
| `emberly://catalog` | Every resource this token can read, with columns, filters, ranges, allowlists and relations. Scope-filtered. |
| `emberly://data-traps` | The traps below, in brief. Read before reporting a number. |

Pinning the catalog once saves a `list_resources` + `describe_resource` round trip per question.

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

### `mlgw/accounts.property_name` holds a UUID

Despite the name, the column currently stores the property id, so grouping by it produces a
bucket labelled with a guid. It is deliberately **not** groupable — group by
`resman_property_id` and mean it. (The underlying sync bug is separate and still open.)

### `units → utility_accounts` is matched by address, not by a key

MLGW knows nothing about ResMan unit ids; the link is inferred from the service address. An
account whose address didn't match is **invisible** to that relation — so a per-unit utility
figure is a lower bound. `aggregate_related` returns an `(unmatched)` bucket; report it.

### Sampled group domains

`describe_resource` learns each groupable column's values from a **5,000-row sample**, and
reports `domain_complete`. When that is false, a rare value could be missing from the domain —
and a **missing bucket reads exactly like a real zero**.

Count aggregates close this: they reconcile the buckets against an exact total and put
everything unaccounted into an **`(other)`** bucket. If `(other)` is large, the domain missed
something and you should look before reporting. Measure aggregates build their buckets from the
rows they scan, so they were never affected.

`(other)` also collects rows whose period column is null — they belong to no calendar bucket.

### Caveats travel with the resource

`describe_resource` returns **`notes_before_you_report`** — the caveats that resource carries,
declared next to its columns in `resman-resources.ts`. `units` warns about the occupancy split,
`mlgw/accounts` about the UUID in `property_name` and the address-based matching,
`property-snapshots` about its uneven coverage.

Read them. They are the same traps documented below, but they arrive attached to the data
rather than in a page nobody reading a tool response has open. `list_resources` flags which
resources have them via `has_caveats`.

### PostgREST caps every response at 1,000 rows

`.limit(20000)` against a 3,542-row table returns **1,000 rows and no error**. Every scan in
the engine therefore pages, ordered by the id column so offset paging is a total order and no
row lands on two pages.

This bit for real: a `sum` over `mlgw/payments` was quietly a sum over the first 1,000 of 2,885
rows, and reported `truncated: false` because 1,000 was under the client-side 20,000 cap. Count
aggregates were never affected — they use exact HEAD counts and transfer no rows.

If you are writing new code against this mirror, do not trust a short response to mean "that
was all of it".

### History exists at two levels, and neither goes back far

`property-snapshots` is property-level and starts 2024-07-21. `unit-snapshots` is per-unit and
starts **2026-07-30** — the day it was created. Neither can be backfilled further: the ResMan
mirror upserts current state, so the past exists nowhere to recover it from.

A `unit-snapshots` range before that returns nothing. That is missing history, **not** a period
with no units. Counting its rows counts unit-days, not units — filter to one `snapshot_date`
for a unit count.

### An empty table is not a zero

`query_resource` and `aggregate_resource` add a `note` when the resource has **no rows at all**,
because an empty result otherwise looks identical to a filtered-out one. This is live today:
`entry-logs` has 0 rows, so "who came through the gate last night" would read as "nobody came
through" rather than "the scanners have never been used". Repeat the distinction; don't report
the zero.

### Manual fields are sparse

Vehicle registration, `holding_unit` and similar are entered by hand in ResMan. A blank means
**nobody typed it**, not that the answer is no. 41% of occupied units have no vehicle on
file; that is a data-entry rate, not a car-ownership rate. Say which you are reporting.

---

## Scopes, budget and audit

A token reads only the resources in its scope list. **An empty list grants nothing** — use
`*` for everything. See [[MCP Server Setup]]. A relation's target is checked independently of
its source, so no hop widens a token's reach.

**Call budget: 600 tool calls per token per 15 minutes.** Spent per *tool call*, not per HTTP
request — a JSON-RPC batch carries many calls in one request, so metering the request would
let a batch of 500 through as one unit. Exceeding it returns JSON-RPC error `-32003`. Sized to
be invisible to real work and to stop a runaway loop within a minute or two.

Every tool call is written to `access_token_audit_log` with the tool, resource and arguments —
**with free text redacted.** Ids, filter values and column names are kept: they are drawn from
a fixed vocabulary and they are the point of the trail, recording which rows a token touched.
A `search` term is different in kind — typed by a human, matched against names — so it is
stored as its length plus an 8-hex digest:

```json
{ "resource": "residents", "search": { "redacted": true, "length": 9, "digest": "a1b2c3d4" } }
```

That keeps the two things the trail needs — *a search ran*, and *the same search ran eleven
times* — without keeping the term. Redaction happens inside `logAccessTokenUse`, not at the
call sites, so a future caller cannot forget it.

---

## Adding a capability

All of it is declarative. To make a column searchable, groupable, sortable or joinable, add it
to the resource in `apps/web/lib/resman-resources.ts`:

```ts
searchable: ["title", "notes"],          // full scan — keep short
ranges:     { reported: "date_reported" },
groupable:  ["status", "priority"],      // LOW-CARDINALITY only
measures:   ["market_rent", "balance"],  // numeric only
periods:    { reported: { column: "date_reported", kind: "date" } },  // kind matters — see below
entities:   ["resman_unit_id", "technician"],   // per-entity series; HIGH cardinality is fine
notes:      ["date_completed is entered by hand; blank means unentered."],  // surfaced by describe_resource
sortable:   ["date_reported", "number"],
relations:  [{ name: "unit", resource: "units",
               localColumn: "resman_unit_id", foreignColumn: "resman_unit_id", kind: "one" }],
```

Rules the tests enforce (`apps/web/tests/mcp-capabilities.test.js`,
`apps/web/tests/mcp-server-surface.test.js`):

- **Never make a withheld column searchable.** Matching on a value leaks it even when the
  column is not returned.
- **Never make a name or free-text column groupable.** Grouping by a person's name turns an
  aggregate into an enumeration of people — `tenant_name` on the gate log is the sharp case:
  grouping by it ranks residents by how often they come and go.
- **Every relation must point at a real resource** and, for a `many` hop, at a column the
  target exposes as a filter.
- **Every resource must declare at least one capability.** A resource reachable only as an
  undifferentiated list is how the MLGW and gate tables sat for a release.
- **A `periods` entry must name the right `kind`.** `date` for a plain DATE column, `timestamp`
  for an instant. Getting this wrong shifts every bucket boundary by the UTC offset.

If a new free-text argument is ever added to a tool, add its key to `REDACTED_ARG_KEYS` in
`apps/web/lib/access-tokens.ts`.
