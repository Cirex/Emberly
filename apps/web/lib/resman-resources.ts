/**
 * Resource registry for the private read-only ResMan REST API.
 *
 * Each resource maps one mirror table (`resman_*` / `mlgw_*`) to a list + detail
 * endpoint. The `selectColumns` array is an explicit PII allowlist: only the
 * columns listed here are ever queried from the database, and columns absent
 * from the list (birthdate, driver's license, raw jsonb payloads, storage
 * paths, free-text detail, etc.) are never exposed by this shared-key API.
 *
 * `selectColumns` / `idColumn` / `order.column` / `filters` are typed against
 * the generated `Database` row types via `defineResource`, so a typo or a
 * drift that would leak a withheld column fails to compile. See docs/resman-api.md
 * for the human-readable field policy.
 */

import type { Database } from "@/types/database";

type Tables = Database["public"]["Tables"];
export type TableName = keyof Tables;
type RowOf<T extends TableName> = Tables[T]["Row"];
type ColumnOf<T extends TableName> = keyof RowOf<T> & string;

interface ResmanResourceDef<T extends TableName> {
  /** Resource identity for logs; the URL path is file-based routing under
   *  /api/resman/* (ResMan) or /api/mlgw/* (MLGW). e.g. "units", "mlgw/bills". */
  name: string;
  table: T;
  /** Natural-key primary column used by the /{id} detail endpoint. */
  idColumn: ColumnOf<T>;
  /** Column allowlist queried from the DB. Withheld columns are simply absent. */
  selectColumns: readonly ColumnOf<T>[];
  /**
   * Columns returned to the client. Defaults to `selectColumns`. Override when
   * a resource derives fields (e.g. contact-presence booleans) or withholds a
   * queried-but-internal column from the response.
   */
  publicColumns?: readonly string[];
  /** Optional post-query projection: derive fields, then response is limited to publicColumns. */
  derive?: (row: Record<string, unknown>) => Record<string, unknown>;
  /** Query-param -> column map for equality filters. */
  filters?: Readonly<Record<string, ColumnOf<T>>>;
  /** Subset of `filters` keys whose values are parsed as booleans. */
  booleanFilters?: readonly string[];
  /**
   * PostgREST `or=` expression rows must satisfy when the caller is a scanner
   * device. Back-office tokens (and the MCP built on them) see everything;
   * this trims what a gate iPad can ever query.
   */
  scannerVisible?: string;
  order: { column: ColumnOf<T>; ascending: boolean };
  /** Secondary sort applied after `order` — for running-balance style data
   *  where the primary column has ties that must not shuffle. */
  tiebreak?: { column: ColumnOf<T>; ascending: boolean };
  /**
   * Opt into DELTA reads: `?<param>=<ISO timestamp>` narrows the list to rows
   * whose `column` is strictly greater. Separate from `filters` because that map
   * is equality-only, and a delta needs `gt`.
   *
   * Only worth declaring on a table whose timestamp actually tracks CHANGE. The
   * mirror tables re-upsert every row each sync pass, so an unconditional
   * updated_at trigger makes the delta return everything — see
   * deltas/2026-07-24-work-order-change-detection.sql.
   */
  since?: { param: string; column: ColumnOf<T> };

  // --- capability metadata (MCP + REST) ----------------------------------
  //
  // Everything below is an ALLOWLIST, for the same reason `selectColumns` is:
  // the caller names a capability, never a raw column or expression. A column
  // absent from these lists cannot be searched, grouped, summed or sorted on,
  // however the request is phrased.

  /**
   * Text columns a substring search may scan. Deliberately narrow: a leading
   * wildcard defeats every index, so each entry is a full scan of that column.
   * Never list a column withheld from `publicColumns` — matching on a hidden
   * value leaks it by inference even when the column isn't returned.
   */
  searchable?: readonly ColumnOf<T>[];
  /**
   * Param -> column for range filters, addressed as `<param>_from` / `<param>_to`
   * (inclusive). Dates and numerics only.
   */
  ranges?: Readonly<Record<string, ColumnOf<T>>>;
  /**
   * Columns a GROUP BY may use. Restricted to LOW-CARDINALITY columns on
   * purpose — grouping by a name or an id would both blow up the result and
   * turn an aggregate into a way of enumerating people.
   */
  groupable?: readonly ColumnOf<T>[];
  /** Numeric columns sum/avg/min/max may target. */
  measures?: readonly ColumnOf<T>[];
  /**
   * Date columns a time-series aggregate may bucket by (day/week/month/…),
   * keyed by the name the caller uses.
   *
   * `kind` is not cosmetic. A "date" is a plain calendar date with no timezone,
   * and converting it would be wrong. A "timestamp" is an instant, and which
   * day it falls on depends on where you stand — those are bucketed in the
   * property's local zone, because a UTC boundary cuts a Memphis night in half.
   */
  periods?: Readonly<Record<string, { column: ColumnOf<T>; kind: "date" | "timestamp" }>>;
  /**
   * Columns identifying a SUBJECT for per-entity time series (an account, a
   * unit, a technician). Unlike `groupable` these are deliberately HIGH
   * cardinality: anomaly detection returns only the outliers, so the answer
   * stays small even when the entity space does not. They are not groupable and
   * do not become so by appearing here — nothing can enumerate them.
   */
  entities?: readonly ColumnOf<T>[];
  /**
   * Caveats a caller must know BEFORE reporting a number from this resource.
   * Surfaced by describe_resource and the catalog, so the warning travels with
   * the data instead of living only in a document nobody reading the response
   * has open.
   */
  notes?: readonly string[];
  /**
   * Named CANONICAL predicates — the definitions that decide whether a headline
   * number is right, expressed once instead of re-derived by every caller.
   *
   * The motivating case: this property has THREE live definitions of occupancy
   * that disagree (units.occupied 63.2%, occupancy_status='Occupied' 56.5%,
   * property_snapshots.occupancy_pct 64.3%), and the true rate needs
   * holding_unit and excluded_from_occupancy dropped from the DENOMINATOR —
   * logic that lives in @emberly/core and the manager app and that the MCP was
   * asking callers to reproduce by hand. `scope: "rentable"` makes that
   * unmissable instead of a thing you have to already know.
   *
   * AND of simple predicates only. Anything needing OR stays a documented note
   * rather than being half-expressed here and quietly wrong.
   */
  scopes?: Readonly<Record<string, {
    description: string;
    /** ANDed predicates. */
    filters?: readonly ScopePredicate<ColumnOf<T>>[];
    /**
     * An OR group, ANDed with `filters`. Exactly one group, on purpose: the
     * definitions that need it ("delinquent" = a balance OR a stated reason)
     * are one disjunction deep, and allowing arbitrary nesting would rebuild
     * a query language behind a capability name.
     */
    any?: readonly ScopePredicate<ColumnOf<T>>[];
  }>>;
  /** Columns the caller may sort by (beyond the resource's default order). */
  sortable?: readonly ColumnOf<T>[];
  /**
   * Declared one-hop traversals to other resources. The MCP `related_resource`
   * tool walks these; nothing else is reachable, so no caller can invent a join.
   */
  relations?: readonly {
    /** Traversal name, e.g. "residents" on the units resource. */
    name: string;
    /** Target resource name (must exist in RESMAN_RESOURCES). */
    resource: string;
    /** Column on THIS resource holding the key. */
    localColumn: ColumnOf<T>;
    /** Column on the TARGET resource to match it against. */
    foreignColumn: string;
    /** "many" lists the target rows; "one" fetches a single row. */
    kind: "one" | "many";
    /** Why this hop exists / what to watch for. Surfaced by describe_resource. */
    note?: string;
  }[];
}

/**
 * One predicate inside a canonical scope.
 *
 * `is_null` / `not_null` exist because the most important question the monitor
 * answers — "what is still OPEN" — is `resolved_at is null`, and an
 * equality-only vocabulary cannot say it. `in` exists because "open work order"
 * is a SET of statuses, and spelling it as four separate scopes would be four
 * chances to disagree with the sync.
 */
export interface ScopePredicate<C extends string = string> {
  column: C;
  op: "eq" | "neq" | "gte" | "lte" | "in" | "is_null" | "not_null";
  /** For eq/neq/gte/lte. */
  value?: string | number | boolean;
  /** For `in`. */
  values?: readonly string[];
}

/** A declared one-hop traversal between two resources. */
export interface ResmanRelation {
  name: string;
  resource: string;
  localColumn: string;
  foreignColumn: string;
  kind: "one" | "many";
  note?: string;
}

/** Erased resource shape consumed by the generic engine. */
export interface ResmanResource {
  name: string;
  table: TableName;
  idColumn: string;
  selectColumns: readonly string[];
  publicColumns: readonly string[];
  derive?: (row: Record<string, unknown>) => Record<string, unknown>;
  filters: Readonly<Record<string, string>>;
  booleanFilters: readonly string[];
  scannerVisible?: string;
  order: { column: string; ascending: boolean };
  tiebreak?: { column: string; ascending: boolean };
  since?: { param: string; column: string };
  searchable: readonly string[];
  ranges: Readonly<Record<string, string>>;
  groupable: readonly string[];
  measures: readonly string[];
  periods: Readonly<Record<string, { column: string; kind: "date" | "timestamp" }>>;
  entities: readonly string[];
  notes: readonly string[];
  scopes: Readonly<Record<string, {
    description: string;
    filters: readonly ScopePredicate<string>[];
    any: readonly ScopePredicate<string>[];
  }>>;
  sortable: readonly string[];
  relations: readonly ResmanRelation[];
}

function defineResource<T extends TableName>(def: ResmanResourceDef<T>): ResmanResource {
  return {
    name: def.name,
    table: def.table,
    idColumn: def.idColumn,
    selectColumns: def.selectColumns,
    publicColumns: def.publicColumns ?? def.selectColumns,
    derive: def.derive,
    filters: def.filters ?? {},
    booleanFilters: def.booleanFilters ?? [],
    scannerVisible: def.scannerVisible,
    order: def.order,
    tiebreak: def.tiebreak,
    since: def.since,
    searchable: def.searchable ?? [],
    ranges: def.ranges ?? {},
    groupable: def.groupable ?? [],
    measures: def.measures ?? [],
    periods: def.periods ?? {},
    entities: def.entities ?? [],
    notes: def.notes ?? [],
    scopes: Object.fromEntries(
      Object.entries(def.scopes ?? {}).map(([name, sc]) => [
        name,
        { description: sc.description, filters: sc.filters ?? [], any: sc.any ?? [] },
      ]),
    ),
    // The default sort column is always sortable — asking for the order the
    // resource already uses should never be rejected.
    sortable: def.sortable ?? [def.order.column],
    relations: (def.relations ?? []) as readonly ResmanRelation[],
  };
}

// --- ResMan domain -------------------------------------------------------

export const propertiesResource = defineResource({
  name: "properties",
  table: "resman_properties",
  idColumn: "resman_property_id",
  selectColumns: [
    "resman_property_id", "resman_account_id", "name", "custom_name", "abbreviation",
    "phone", "email", "website", "logo_url", "management_company", "property_type",
    "time_zone", "regional_manager", "property_manager", "leasing_agent",
    "resident_portal_url", "address", "city", "state", "postal_code", "unit_count",
    "last_sync_date", "synced_at", "created_at", "updated_at",
  ],
  filters: { account: "resman_account_id" },
  order: { column: "name", ascending: true },
  searchable: ["name", "custom_name", "abbreviation"],
  ranges: { unit_count: "unit_count" },
  // Single-property today, so these group columns are all degenerate. They are
  // declared anyway: the shape is right for a second property, and a bucket of
  // one is an honest answer where a missing capability is a dead end.
  groupable: ["property_type", "state", "city", "management_company"],
  measures: ["unit_count"],
  sortable: ["name", "unit_count"],
  relations: [
    { name: "buildings", resource: "buildings", localColumn: "resman_property_id",
      foreignColumn: "resman_property_id", kind: "many" },
    { name: "units", resource: "units", localColumn: "resman_property_id",
      foreignColumn: "resman_property_id", kind: "many" },
    { name: "floorplans", resource: "floorplans", localColumn: "resman_property_id",
      foreignColumn: "resman_property_id", kind: "many" },
  ],
});

export const buildingsResource = defineResource({
  name: "buildings",
  table: "resman_buildings",
  idColumn: "resman_building_id",
  selectColumns: [
    "resman_building_id", "resman_property_id", "name", "synced_at", "created_at", "updated_at",
  ],
  filters: { property: "resman_property_id" },
  order: { column: "name", ascending: true },
  searchable: ["name"],
  groupable: ["resman_property_id"],
  sortable: ["name"],
  relations: [
    { name: "property", resource: "properties", localColumn: "resman_property_id",
      foreignColumn: "resman_property_id", kind: "one" },
    { name: "units", resource: "units", localColumn: "resman_building_id",
      foreignColumn: "resman_building_id", kind: "many" },
  ],
});

export const floorplansResource = defineResource({
  name: "floorplans",
  table: "resman_floorplans",
  idColumn: "resman_floorplan_id",
  selectColumns: [
    "resman_floorplan_id", "resman_property_id", "name", "description",
    "square_feet", "market_rent", "synced_at", "created_at", "updated_at",
  ],
  filters: { property: "resman_property_id" },
  order: { column: "name", ascending: true },
  searchable: ["name", "description"],
  ranges: { square_feet: "square_feet", market_rent: "market_rent" },
  groupable: ["resman_property_id"],
  measures: ["square_feet", "market_rent"],
  sortable: ["name", "square_feet", "market_rent"],
  relations: [
    { name: "property", resource: "properties", localColumn: "resman_property_id",
      foreignColumn: "resman_property_id", kind: "one" },
    { name: "units", resource: "units", localColumn: "resman_floorplan_id",
      foreignColumn: "resman_floorplan_id", kind: "many",
      note: "floorplans.market_rent is the PLAN's asking rent; units.market_rent is the unit's own. They differ." },
  ],
});

export const unitsResource = defineResource({
  name: "units",
  table: "resman_units",
  idColumn: "resman_unit_id",
  selectColumns: [
    "resman_unit_id", "resman_property_id", "resman_building_id", "resman_floorplan_id",
    "number", "current_lease_id", "pending_lease_id", "availability", "lease_status",
    "occupancy_status", "classification", "notes", "occupied", "market_rent", "lease_rent",
    "deposit_required", "deposit_held", "balance", "bedrooms", "bathrooms", "pets_permitted",
    "affordable_unit", "holding_unit", "excluded_from_occupancy", "available_for_online_marketing",
    "street", "city", "state", "postal_code", "country", "lease_start_date", "lease_end_date",
    "move_in_date", "move_out_date", "tenant_names",
    // Delinquency-with-aging enrichment — the manager app's heat map and
    // callouts read these; harmless extras for the other apps.
    "current_month_balance", "last_month_balance", "period_balance", "previous_balance",
    "times_late", "delinquency_reason", "leasing_agent",
    "source_url", "scraped_at", "synced_at",
    "created_at", "updated_at",
  ],
  filters: {
    property: "resman_property_id",
    building: "resman_building_id",
    floorplan: "resman_floorplan_id",
    lease_status: "lease_status",
    occupancy_status: "occupancy_status",
  },
  // Holding units are ResMan bookkeeping placeholders ("EFF Holding unit",
  // "Diamond Emberly 2", …) parked at the office address — there is no door a
  // guard could stand in front of, so scanners never see them. The two Model
  // units are real, physical apartments and stay visible.
  scannerVisible: "excluded_from_occupancy.eq.false,availability.eq.Model",
  order: { column: "number", ascending: true },
  searchable: ["number", "tenant_names", "street", "notes"],
  ranges: {
    market_rent: "market_rent",
    lease_rent: "lease_rent",
    balance: "balance",
    lease_end: "lease_end_date",
    move_in: "move_in_date",
    move_out: "move_out_date",
  },
  // `occupied` (boolean) and `occupancy_status` (three-state) are BOTH here on
  // purpose: they answer different questions and disagree by 60 units. See
  // docs/resman-mcp.md — grouping by the wrong one is the single most common
  // way to get an occupancy number wrong.
  groupable: [
    "occupancy_status", "occupied", "lease_status", "classification", "availability",
    "bedrooms", "resman_building_id", "resman_floorplan_id", "holding_unit",
    "excluded_from_occupancy", "pets_permitted", "affordable_unit", "leasing_agent",
  ],
  measures: [
    "market_rent", "lease_rent", "balance", "current_month_balance",
    "deposit_held", "deposit_required", "times_late", "bedrooms", "bathrooms",
  ],
  sortable: ["number", "market_rent", "lease_rent", "balance", "lease_end_date", "move_in_date"],
  entities: ["resman_unit_id"],
  // The denominator problem, solved once. Every occupancy figure this property
  // quotes should start from `rentable`.
  scopes: {
    rentable: {
      description:
        "Real, rentable apartments — excludes ResMan bookkeeping placeholders (holding_unit) and units flagged out of the occupancy count. THE denominator for any occupancy or vacancy rate.",
      filters: [
        { column: "holding_unit", op: "eq", value: false },
        { column: "excluded_from_occupancy", op: "eq", value: false },
      ],
    },
    occupied: {
      description: "Rentable units with someone living in them (the PHYSICAL view — includes Notice).",
      filters: [
        { column: "holding_unit", op: "eq", value: false },
        { column: "excluded_from_occupancy", op: "eq", value: false },
        { column: "occupied", op: "eq", value: true },
      ],
    },
    vacant: {
      description: "Rentable units with nobody living in them.",
      filters: [
        { column: "holding_unit", op: "eq", value: false },
        { column: "excluded_from_occupancy", op: "eq", value: false },
        { column: "occupied", op: "eq", value: false },
      ],
    },
    delinquent: {
      // Matches isDelinquentUnit in lib/manager-delinquency.ts. ResMan writes
      // an EMPTY STRING for "no reason given", not null, so this is `neq ''`
      // rather than a null check — a not-null test would match every row.
      description:
        "Rentable units carrying a positive balance OR a stated delinquency reason. Matches the manager app's definition; a balance alone and a reason alone both count.",
      filters: [
        { column: "holding_unit", op: "eq", value: false },
        { column: "excluded_from_occupancy", op: "eq", value: false },
      ],
      any: [
        { column: "balance", op: "gte", value: 0.01 },
        { column: "delinquency_reason", op: "neq", value: "" },
      ],
    },
  },
  notes: [
    "`occupied` (boolean) and `occupancy_status` (Occupied/Vacant/Notice) answer DIFFERENT questions and disagree by 60 units. The gap is the Notice bucket — under eviction or notice given, still living there. Use `occupied` for anything physical (parking, utilities, access); use `occupancy_status` for leasing and reporting.",
    "`lease_status` here is the All-Units report's narrower view and does NOT contain Evicted or Former. For terminal lease states use the `leases` resource, whose `status` is the full lifecycle.",
    "`holding_unit` and `excluded_from_occupancy` units are ResMan bookkeeping placeholders. Exclude them from any occupancy RATE and say that you did.",
  ],
  periods: {
    move_in: { column: "move_in_date", kind: "date" },
    move_out: { column: "move_out_date", kind: "date" },
    lease_end: { column: "lease_end_date", kind: "date" },
  },
  relations: [
    { name: "current_lease", resource: "leases", localColumn: "current_lease_id",
      foreignColumn: "resman_lease_id", kind: "one",
      note: "Denormalized pointer with no FK. It can lag the leases table — 14 units currently disagree on lease status between the two sources." },
    { name: "leases", resource: "leases", localColumn: "resman_unit_id",
      foreignColumn: "resman_unit_id", kind: "many", note: "Every lease this unit has ever had." },
    { name: "work_orders", resource: "work-orders", localColumn: "resman_unit_id",
      foreignColumn: "resman_unit_id", kind: "many" },
    { name: "transactions", resource: "transactions", localColumn: "resman_unit_id",
      foreignColumn: "resman_unit_id", kind: "many" },
    { name: "utility_accounts", resource: "mlgw/accounts", localColumn: "resman_unit_id",
      foreignColumn: "resman_unit_id", kind: "many",
      note: "MLGW accounts matched to this unit BY ADDRESS, not by a shared key — absence may mean unmatched rather than no service." },
    { name: "building", resource: "buildings", localColumn: "resman_building_id",
      foreignColumn: "resman_building_id", kind: "one" },
    { name: "floorplan", resource: "floorplans", localColumn: "resman_floorplan_id",
      foreignColumn: "resman_floorplan_id", kind: "one" },
  ],
});

export const leasesResource = defineResource({
  name: "leases",
  table: "resman_leases",
  idColumn: "resman_lease_id",
  selectColumns: [
    "resman_lease_id", "unit_lease_group_id", "resman_property_id", "resman_unit_id",
    "unit_number", "status", "approval_status", "application_date", "signed_date",
    "start_date", "end_date", "move_in_date", "move_out_date", "leasing_agent",
    "renewal_date", "notice_given_date", "market_rent", "resident_rent", "hap_rent",
    "monthly_charge", "balance", "collection_balance", "reason_for_leaving",
    "is_current_lease", "is_most_recent_lease", "synced_at", "created_at", "updated_at",
  ],
  filters: {
    property: "resman_property_id",
    unit: "resman_unit_id",
    unit_lease_group_id: "unit_lease_group_id",
    status: "status",
    is_current_lease: "is_current_lease",
  },
  booleanFilters: ["is_current_lease"],
  order: { column: "start_date", ascending: false },
  scopes: {
    current: {
      description: "The lease currently in force for each unit — the one to reason about for occupancy or rent.",
      filters: [{ column: "is_current_lease", op: "eq", value: true }],
    },
    terminal: {
      description: "Leases that have ended — Former, Evicted, Cancelled. These never appear in units.lease_status.",
      filters: [{ column: "status", op: "in", values: ["Former", "Evicted", "Cancelled", "Denied"] }],
    },
  },
  searchable: ["unit_number", "leasing_agent", "reason_for_leaving"],
  ranges: { start: "start_date", end: "end_date", move_out: "move_out_date", balance: "balance" },
  // `status` here is the FULL lease lifecycle (Current, Renewed, Evicted,
  // Former, Denied, …) — richer than units.lease_status, which the All-Units
  // report narrows to eight values.
  groupable: ["status", "approval_status", "is_current_lease", "is_most_recent_lease", "leasing_agent", "resman_property_id"],
  measures: ["market_rent", "resident_rent", "hap_rent", "monthly_charge", "balance", "collection_balance"],
  sortable: ["start_date", "end_date", "balance", "move_out_date"],
  entities: ["resman_unit_id"],
  periods: {
    start: { column: "start_date", kind: "date" },
    end: { column: "end_date", kind: "date" },
    move_out: { column: "move_out_date", kind: "date" },
    signed: { column: "signed_date", kind: "date" },
  },
  relations: [
    { name: "unit", resource: "units", localColumn: "resman_unit_id", foreignColumn: "resman_unit_id", kind: "one" },
    { name: "residents", resource: "residents", localColumn: "resman_lease_id", foreignColumn: "resman_lease_id", kind: "many" },
    { name: "transactions", resource: "transactions", localColumn: "resman_lease_id", foreignColumn: "resman_lease_id", kind: "many" },
  ],
});

// Residents carry occupant PII. birthdate, drivers_license[_state],
// identification and raw are NOT in selectColumns (never queried). email /
// phone_numbers are queried only to derive presence booleans and are dropped
// from the response by publicColumns.
export const residentsResource = defineResource({
  name: "residents",
  table: "resman_residents",
  idColumn: "resman_person_lease_id",
  selectColumns: [
    "resman_person_lease_id", "resman_person_id", "resman_lease_id",
    "first_name", "last_name", "gender", "household_status", "language",
    "is_primary", "email", "phone_numbers", "synced_at", "created_at", "updated_at",
  ],
  publicColumns: [
    "resman_person_lease_id", "resman_person_id", "resman_lease_id",
    "first_name", "last_name", "gender", "household_status", "language",
    "is_primary", "has_email", "has_phone", "synced_at", "created_at", "updated_at",
  ],
  derive: (row) => {
    const phones = row.phone_numbers;
    return {
      ...row,
      has_email: typeof row.email === "string" && row.email.trim().length > 0,
      has_phone: Array.isArray(phones) && phones.length > 0,
    };
  },
  filters: {
    lease: "resman_lease_id",
    person: "resman_person_id",
    is_primary: "is_primary",
  },
  booleanFilters: ["is_primary"],
  order: { column: "last_name", ascending: true },
  // Names only. `email` and `phone_numbers` are queried to derive presence
  // booleans and dropped from the response — searching them would leak the
  // withheld value by inference (probe until a match narrows it).
  searchable: ["first_name", "last_name"],
  groupable: ["household_status", "gender", "language", "is_primary"],
  measures: [],
  sortable: ["last_name", "first_name"],
  relations: [
    { name: "lease", resource: "leases", localColumn: "resman_lease_id", foreignColumn: "resman_lease_id", kind: "one" },
  ],
});

export const transactionsResource = defineResource({
  name: "transactions",
  table: "resman_transactions",
  idColumn: "resman_ledger_entry_id",
  selectColumns: [
    "resman_ledger_entry_id", "resman_property_id", "resman_unit_id", "resman_lease_id",
    "transaction_id", "transaction_type", "date", "reference", "batch", "batch_id",
    "category", "ledger_description", "notes", "charges", "credits", "balance", "ledger_sequence",
    "synced_at", "created_at", "updated_at",
  ],
  filters: {
    property: "resman_property_id",
    unit: "resman_unit_id",
    lease: "resman_lease_id",
    transaction_type: "transaction_type",
    category: "category",
  },
  order: { column: "date", ascending: false },
  // The ledger is a running balance: within a date, ResMan's own row order
  // (captured as ledger_sequence at scrape time) is the only correct one.
  tiebreak: { column: "ledger_sequence", ascending: false },
  searchable: ["ledger_description", "reference", "notes"],
  ranges: { date: "date", charges: "charges", credits: "credits" },
  groupable: ["transaction_type", "category", "resman_property_id"],
  measures: ["charges", "credits", "balance"],
  sortable: ["date", "charges", "credits"],
  entities: ["resman_unit_id", "resman_lease_id"],
  periods: { date: { column: "date", kind: "date" } },
  relations: [
    { name: "unit", resource: "units", localColumn: "resman_unit_id", foreignColumn: "resman_unit_id", kind: "one" },
    { name: "lease", resource: "leases", localColumn: "resman_lease_id", foreignColumn: "resman_lease_id", kind: "one" },
  ],
});

export const workOrdersResource = defineResource({
  name: "work-orders",
  table: "resman_work_orders",
  idColumn: "resman_work_order_id",
  selectColumns: [
    "resman_work_order_id", "number", "resman_unit_id", "unit_lease_group_id",
    "resman_lease_id", "unit_number", "resman_property_id", "status", "priority",
    "category", "title", "notes", "completion_notes", "technician", "date_reported",
    "date_scheduled", "date_completed", "is_make_ready", "callback_requested",
    "callback_completed", "tags", "is_duplicate", "callback_status",
    "callback_matched_work_order_id", "callback_engine_version", "callback_source",
    "callback_detected_at", "synced_at", "created_at", "updated_at",
  ],
  filters: {
    property: "resman_property_id",
    unit: "resman_unit_id",
    status: "status",
    priority: "priority",
    callback_status: "callback_status",
  },
  // The maintenance app's poll asks only for what moved since its last
  // successful read, so a quiet tick is a near-empty response and can run often.
  since: { param: "updated_since", column: "updated_at" },
  order: { column: "date_reported", ascending: false },
  searchable: ["title", "notes", "completion_notes", "unit_number", "technician"],
  ranges: { reported: "date_reported", scheduled: "date_scheduled", completed: "date_completed" },
  // NOT groupable by `title` or `notes` — free text, effectively unique per row,
  // so a GROUP BY on it is a full dump wearing an aggregate's clothes.
  groupable: [
    "status", "priority", "category", "technician", "is_make_ready",
    "is_duplicate", "callback_status", "callback_requested", "resman_property_id",
  ],
  measures: [],
  sortable: ["date_reported", "date_scheduled", "date_completed", "number"],
  entities: ["resman_unit_id", "technician", "category"],
  // "Open" was previously something a caller had to discover by reading the
  // status values — the work_order_aging prompt literally told them to. The set
  // mirrors OPEN_WORK_ORDER_STATUSES in supabase/sync/src/shared/push.ts, which
  // is the definition the alerting already uses.
  scopes: {
    open: {
      description:
        "Work orders not in a terminal state. Mirrors the sync's own open set — use this rather than guessing which statuses count.",
      filters: [{ column: "status", op: "in", values: ["Open", "In Progress", "Not Started", "On Hold", "Submitted", "Scheduled"] }],
    },
    closed: {
      description: "Terminal work orders (Completed / Closed / Canceled).",
      filters: [{ column: "status", op: "in", values: ["Completed", "Closed", "Canceled"] }],
    },
    unscheduled_open: {
      description: "Open work orders with no scheduled date — the backlog nobody has committed to yet.",
      filters: [
        { column: "status", op: "in", values: ["Open", "In Progress", "Not Started", "On Hold", "Submitted", "Scheduled"] },
        { column: "date_scheduled", op: "is_null" },
      ],
    },
  },
  periods: {
    reported: { column: "date_reported", kind: "date" },
    scheduled: { column: "date_scheduled", kind: "date" },
    completed: { column: "date_completed", kind: "date" },
  },
  relations: [
    { name: "unit", resource: "units", localColumn: "resman_unit_id", foreignColumn: "resman_unit_id", kind: "one" },
    { name: "lease", resource: "leases", localColumn: "resman_lease_id", foreignColumn: "resman_lease_id", kind: "one" },
  ],
});

// --- MLGW domain ---------------------------------------------------------

export const mlgwAccountsResource = defineResource({
  name: "mlgw/accounts",
  table: "mlgw_accounts",
  idColumn: "id",
  selectColumns: [
    "id", "resman_property_id", "property_name", "account_number", "service_address",
    "resman_unit_id", "unit_number", "is_house_account", "due_now", "due_date",
    "synced_at", "created_at", "updated_at",
  ],
  filters: {
    property: "resman_property_id",
    unit: "resman_unit_id",
    account_number: "account_number",
    is_house_account: "is_house_account",
  },
  booleanFilters: ["is_house_account"],
  order: { column: "account_number", ascending: true },
  searchable: ["service_address", "unit_number", "account_number"],
  ranges: { due_now: "due_now", due_date: "due_date" },
  // NOT groupable by `property_name`: despite the name it currently holds the
  // property UUID, not a name, so grouping by it produces a bucket labelled
  // with a guid. Group by resman_property_id and mean it.
  groupable: ["is_house_account", "resman_property_id"],
  notes: [
    "`property_name` currently stores the property UUID, not a name — a sync bug. Group by `resman_property_id` instead; property_name is deliberately not groupable.",
    "The link to `units` is inferred from the SERVICE ADDRESS, not a shared key, so an unmatched account is invisible to that relation and any per-unit utility figure is a lower bound.",
  ],
  measures: ["due_now"],
  sortable: ["account_number", "due_now", "due_date"],
  relations: [
    { name: "bills", resource: "mlgw/bills", localColumn: "id",
      foreignColumn: "mlgw_account_id", kind: "many" },
    { name: "payments", resource: "mlgw/payments", localColumn: "id",
      foreignColumn: "mlgw_account_id", kind: "many" },
    { name: "unit", resource: "units", localColumn: "resman_unit_id",
      foreignColumn: "resman_unit_id", kind: "one",
      note: "Matched by address, not a ResMan key — an unmatched account has a null resman_unit_id." },
  ],
});

// Bills: raw jsonb and file_path (a private Storage path to the source PDF,
// which contains full billing PII) are withheld.
export const mlgwBillsResource = defineResource({
  name: "mlgw/bills",
  table: "mlgw_bills",
  idColumn: "id",
  selectColumns: [
    "id", "document_key", "mlgw_account_id", "resman_property_id", "document_id",
    "is_current", "bill_date", "due_date", "amount_due", "balance_forward",
    "average_temperature", "bill_for", "gas_usage", "gas_read_start_date",
    "gas_read_end_date", "gas_total", "electric_usage", "electric_read_start_date",
    "electric_read_end_date", "electric_total", "water_usage", "water_read_start_date",
    "water_read_end_date", "water_total", "sewer_usage", "sewer_read_start_date",
    "sewer_read_end_date", "sewer_total", "other_mlgw_total", "non_mlgw_total",
    "street_light_fee_total", "electrical_late_fee_total", "security_deposit_total",
    "smart_meter_connect_charge_total", "credit_balance_transfer_total",
    "share_the_pennies_total", "water_cross_connection_fee_total",
    "leasing_outdoor_lighting_total", "mosquito_rodent_control_fee_total",
    "sewer_charge_total", "storm_water_fee_total", "solid_waste_fee_total",
    "synced_at", "created_at", "updated_at",
  ],
  filters: {
    property: "resman_property_id",
    account: "mlgw_account_id",
    is_current: "is_current",
  },
  booleanFilters: ["is_current"],
  order: { column: "bill_date", ascending: false },
  ranges: {
    bill_date: "bill_date",
    due_date: "due_date",
    amount_due: "amount_due",
    gas_read_end: "gas_read_end_date",
    electric_read_end: "electric_read_end_date",
    water_read_end: "water_read_end_date",
  },
  groupable: ["is_current", "bill_for", "resman_property_id"],
  // The per-utility totals are what "what did we spend on water in Q1" needs.
  // Usage columns sit alongside them because spend and consumption move apart —
  // a rate change shows up in one and not the other.
  measures: [
    "amount_due", "balance_forward", "gas_total", "electric_total", "water_total",
    "sewer_total", "gas_usage", "electric_usage", "water_usage", "sewer_usage",
    "other_mlgw_total", "non_mlgw_total", "storm_water_fee_total",
    "solid_waste_fee_total", "sewer_charge_total", "average_temperature",
  ],
  sortable: ["bill_date", "due_date", "amount_due"],
  entities: ["mlgw_account_id"],
  periods: {
    bill_date: { column: "bill_date", kind: "date" },
    due_date: { column: "due_date", kind: "date" },
  },
  relations: [
    { name: "account", resource: "mlgw/accounts", localColumn: "mlgw_account_id",
      foreignColumn: "id", kind: "one" },
  ],
});

// Payments: card fields are already absent from the schema; free-text
// detail_text is withheld from this shared-key API.
export const mlgwPaymentsResource = defineResource({
  name: "mlgw/payments",
  table: "mlgw_payments",
  idColumn: "id",
  selectColumns: [
    "id", "mlgw_account_id", "resman_property_id", "account_number", "reference_number",
    "status", "amount", "paid_date", "payment_method", "authorization_number",
    "account_selection", "fetched_at", "detail_fetched_at", "created_at", "updated_at",
  ],
  filters: {
    property: "resman_property_id",
    account: "mlgw_account_id",
    reference_number: "reference_number",
    status: "status",
    payment_method: "payment_method",
  },
  order: { column: "paid_date", ascending: false },
  searchable: ["account_number", "reference_number", "authorization_number"],
  ranges: { paid_date: "paid_date", amount: "amount" },
  // NOT `account_selection`: 190 distinct values over 2,885 rows — high enough
  // that grouping by it enumerates rather than aggregates.
  groupable: ["status", "payment_method", "resman_property_id"],
  measures: ["amount"],
  sortable: ["paid_date", "amount"],
  entities: ["mlgw_account_id"],
  periods: { paid_date: { column: "paid_date", kind: "date" } },
  relations: [
    { name: "account", resource: "mlgw/accounts", localColumn: "mlgw_account_id",
      foreignColumn: "id", kind: "one" },
  ],
});

// --- First-party domain --------------------------------------------------
// Not ResMan mirrors — Emberly's own guest-access tables. Exposed through the
// same engine because they answer the questions staff actually ask ("does this
// unit have an active pass?", "who came through the gate last night?"). No
// REST route exists for them; they are reachable via the MCP only.

// `share_token` is a live credential — presenting it admits a guest — and the
// guest's email/phone/address are PII, so all four are withheld. Status,
// expiry and usage carry the whole operational story.
export const guestPassesResource = defineResource({
  name: "guest-passes",
  table: "guest_passes",
  idColumn: "id",
  selectColumns: [
    "id", "resident_id", "guest_name", "status", "expires_at", "used_at",
    "email_delivery_status", "email_sent_at", "created_at",
  ],
  filters: {
    resident: "resident_id",
    status: "status",
    email_delivery_status: "email_delivery_status",
  },
  order: { column: "created_at", ascending: false },
  // Searchable by guest name for the same reason residents are: "did we issue a
  // pass to this person" is the question the table exists to answer. NOT
  // groupable by it — that turns an aggregate into a guest list.
  searchable: ["guest_name"],
  ranges: { created: "created_at", expires: "expires_at", used: "used_at" },
  groupable: ["status", "email_delivery_status"],
  sortable: ["created_at", "expires_at", "used_at"],
  periods: {
    created: { column: "created_at", kind: "timestamp" },
    used: { column: "used_at", kind: "timestamp" },
  },
  relations: [
    { name: "entries", resource: "entry-logs", localColumn: "id",
      foreignColumn: "guest_pass_id", kind: "many",
      note: "Scans made against this pass. A pass with no entries was issued but never used." },
  ],
});

// The scan ledger verify-pass writes. `notes` stays: it's operational entry
// context, not personal detail — the reason this table exists.
export const entryLogsResource = defineResource({
  name: "entry-logs",
  table: "entry_logs",
  idColumn: "id",
  selectColumns: [
    "id", "resident_id", "guest_pass_id", "entry_type", "tenant_name",
    "unit_address", "property_name", "entered_at", "scanner_id", "notes",
  ],
  filters: {
    resident: "resident_id",
    guest_pass: "guest_pass_id",
    entry_type: "entry_type",
    scanner: "scanner_id",
    unit_address: "unit_address",
  },
  order: { column: "entered_at", ascending: false },
  searchable: ["tenant_name", "unit_address", "notes"],
  // The whole point of this table: "who came through the gate last night" is a
  // time window, and without a range on entered_at it is unaskable.
  ranges: { entered: "entered_at" },
  // `tenant_name` is deliberately absent — grouping by it enumerates residents
  // by how often they come and go. Search it instead.
  groupable: ["entry_type", "scanner_id", "property_name"],
  sortable: ["entered_at"],
  periods: { entered: { column: "entered_at", kind: "timestamp" } },
  relations: [
    { name: "guest_pass", resource: "guest-passes", localColumn: "guest_pass_id",
      foreignColumn: "id", kind: "one",
      note: "Null for a resident scan — only guest entries carry a pass." },
  ],
});

// --- first-party history -------------------------------------------------

/**
 * Nightly property-level snapshot — the ONLY history in the system.
 *
 * The ResMan mirror upserts current state, so `occupancy_status`, `balance` and
 * work-order counts have no past: "how has vacancy moved since spring" is
 * unanswerable from `units` however it is phrased. This table is where that
 * question gets answered, and until now it was not reachable from the MCP at
 * all despite two years of rows sitting in it.
 *
 * Coverage is UNEVEN and the `notes` say so, because the shape is a trap: the
 * occupancy columns run daily from July 2024, while every financial and
 * work-order column only starts when the nightly job did. Averaging
 * `balance_total` across "two years of history" silently averages nine days.
 */
export const propertySnapshotsResource = defineResource({
  name: "property-snapshots",
  table: "property_snapshots",
  idColumn: "snapshot_date",
  selectColumns: [
    "snapshot_date", "total_units", "occupied_units", "vacant_units", "occupancy_pct",
    "rent_roll", "lease_rent_total", "balance_total", "balance_0_30", "balance_31_60",
    "balance_61_90", "balance_90_plus", "delinquent_units", "turns_in_progress",
    "open_work_orders", "utility_due", "source", "created_at",
  ],
  filters: { source: "source" },
  order: { column: "snapshot_date", ascending: false },
  ranges: {
    snapshot_date: "snapshot_date",
    occupancy_pct: "occupancy_pct",
    balance_total: "balance_total",
  },
  groupable: ["source"],
  measures: [
    "total_units", "occupied_units", "vacant_units", "occupancy_pct",
    "rent_roll", "lease_rent_total", "balance_total", "balance_0_30", "balance_31_60",
    "balance_61_90", "balance_90_plus", "delinquent_units", "turns_in_progress",
    "open_work_orders", "utility_due",
  ],
  periods: { snapshot_date: { column: "snapshot_date", kind: "date" } },
  sortable: ["snapshot_date", "occupancy_pct", "balance_total", "open_work_orders"],
  notes: [
    "COVERAGE IS UNEVEN. The occupancy columns (total_units, occupied_units, vacant_units, occupancy_pct) run daily from 2024-07-21. Every OTHER column — rent_roll, balance_total, the aging buckets, delinquent_units, turns_in_progress, open_work_orders, utility_due — is null for the 730 `backfill` rows and only populated on `source = 'nightly'`, which began 2026-07-21. Filter to source=nightly before trending anything financial, and check the per-bucket `count` before quoting an average.",
    "`utility_due` is 0 on every row so far — it reads as a real zero but is more likely not yet wired up. Do not report it as a finding.",
    "`occupancy_pct` here is a THIRD definition, separate from units.occupied and units.occupancy_status, and does not equal either. Say which one a figure came from.",
    "One row per day, but days are missing (736 rows across ~739 days). A period bucket with count 0 may be a gap in collection rather than a real zero.",
  ],
});

/**
 * Per-unit daily history — the drill-down `property-snapshots` cannot give.
 *
 * The property series answers "occupancy was 64% in June". This answers "which
 * units were vacant that whole month", "how long has 1727 LP-3 been empty" and
 * "whose balance has climbed three months running" — none of which the mirror
 * can answer at all, because it upserts current state.
 *
 * It is also what makes `detect_anomalies` work on units rather than only on
 * billing accounts: `resman_unit_id` is declared as an entity here, so a unit
 * can be scored against its own past.
 */
export const unitSnapshotsResource = defineResource({
  name: "unit-snapshots",
  table: "unit_snapshots",
  idColumn: "resman_unit_id",
  selectColumns: [
    "snapshot_date", "resman_unit_id", "unit_number", "resman_building_id",
    "resman_floorplan_id", "occupancy_status", "occupied", "lease_status",
    "availability", "balance", "current_month_balance", "market_rent",
    "lease_rent", "times_late", "holding_unit", "excluded_from_occupancy",
    "move_in_date", "move_out_date", "lease_end_date", "source", "created_at",
  ],
  filters: {
    unit: "resman_unit_id",
    building: "resman_building_id",
    occupancy_status: "occupancy_status",
    lease_status: "lease_status",
    availability: "availability",
    occupied: "occupied",
    source: "source",
  },
  booleanFilters: ["occupied"],
  order: { column: "snapshot_date", ascending: false },
  searchable: ["unit_number"],
  ranges: { snapshot_date: "snapshot_date", balance: "balance", market_rent: "market_rent" },
  groupable: [
    "occupancy_status", "occupied", "lease_status", "availability",
    "resman_building_id", "holding_unit", "excluded_from_occupancy", "source",
  ],
  measures: ["balance", "current_month_balance", "market_rent", "lease_rent", "times_late"],
  periods: { snapshot_date: { column: "snapshot_date", kind: "date" } },
  entities: ["resman_unit_id", "resman_building_id"],
  // Identical to units', because a rate for a past date must be computed the
  // same way as today's or the series compares two different things.
  scopes: {
    rentable: {
      description: "Real, rentable apartments on that date — the denominator for a historical occupancy rate.",
      filters: [
        { column: "holding_unit", op: "eq", value: false },
        { column: "excluded_from_occupancy", op: "eq", value: false },
      ],
    },
    occupied: {
      description: "Rentable units occupied on that date (physical view).",
      filters: [
        { column: "holding_unit", op: "eq", value: false },
        { column: "excluded_from_occupancy", op: "eq", value: false },
        { column: "occupied", op: "eq", value: true },
      ],
    },
  },
  sortable: ["snapshot_date", "balance", "market_rent", "unit_number"],
  relations: [
    { name: "unit", resource: "units", localColumn: "resman_unit_id",
      foreignColumn: "resman_unit_id", kind: "one",
      note: "The unit's CURRENT state. This row is a past day — they will differ, which is the point." },
  ],
  notes: [
    "History starts the day this table was created (2026-07-30). There is no backfill and none is possible: the mirror overwrote the past, so earlier days do not exist anywhere. A range before that returns nothing — which is missing history, NOT a period with no units.",
    "One row per unit per day. Counting rows counts UNIT-DAYS, not units. For a unit count, filter to a single snapshot_date first.",
    "`holding_unit` and `excluded_from_occupancy` are stored per row so an occupancy rate stays computable for a past date. Exclude them from rates, as elsewhere.",
    "For property-level trends going back to 2024, use `property-snapshots` instead — this table is the drill-down, not the long series.",
  ],
});

/**
 * What the scheduled monitor noticed — the push half of the pull tools.
 *
 * `detect_anomalies` and `data_freshness` answer when asked. This is where the
 * nightly run leaves what it saw, so "what needs attention" is a query rather
 * than a thing someone has to remember to go and check.
 *
 * `detail` (the full anomaly, including the baseline that produced the score)
 * is withheld from the response: it is a nested blob that would dominate a
 * page of findings, and `summary` already states the case. Fetch the finding by
 * id when the detail matters.
 */
export const monitorFindingsResource = defineResource({
  name: "monitor-findings",
  table: "monitor_findings",
  idColumn: "id",
  selectColumns: [
    "id", "fingerprint", "kind", "severity", "resource", "entity", "period",
    // `detail` carries the baseline that produced each score. It was withheld
    // to keep pages small, which made the note telling callers to "fetch it by
    // id" describe something no code path could do. The response budget now
    // handles size — a wide row simply means fewer rows per page — so the
    // honest fix is to expose it rather than document a route that isn't there.
    "summary", "detail", "first_seen_at", "last_seen_at", "resolved_at", "notified_at", "created_at",
  ],
  filters: {
    kind: "kind",
    severity: "severity",
    subject: "resource",
    entity: "entity",
    period: "period",
  },
  // "What is open right now" is the question this table exists to answer, and
  // resolved_at is nullable — an equality-only filter map could not express it,
  // so the resource's own note described an impossible query.
  scopes: {
    open: {
      description: "Findings still live — not yet resolved. THE default view; start here.",
      filters: [{ column: "resolved_at", op: "is_null" }],
    },
    resolved: {
      description: "Findings that stopped recurring and were auto-resolved. History, not alarms.",
      filters: [{ column: "resolved_at", op: "not_null" }],
    },
    unannounced: {
      description: "Open findings no notification has gone out for yet — normally empty; non-empty means the notifier is failing.",
      filters: [{ column: "resolved_at", op: "is_null" }, { column: "notified_at", op: "is_null" }],
    },
  },
  order: { column: "last_seen_at", ascending: false },
  searchable: ["summary"],
  ranges: { first_seen: "first_seen_at", last_seen: "last_seen_at" },
  groupable: ["kind", "severity", "resource", "period"],
  periods: {
    last_seen: { column: "last_seen_at", kind: "timestamp" },
    first_seen: { column: "first_seen_at", kind: "timestamp" },
  },
  sortable: ["last_seen_at", "first_seen_at", "severity"],
  notes: [
    "An OPEN finding has resolved_at = null. Rows are not deleted when a problem goes away — they are stamped resolved_at — so an unfiltered query mixes live and historical findings. Use scope 'open' unless you want both.",
    "One row per DISTINCT finding, not per run. `last_seen_at` moves while a finding persists; `first_seen_at` is when it started. A finding seen for a week is one row, not seven.",
    "Anomaly severity is a RANKING, not a statistical claim — with a handful of baseline periods a z of 6 is not a p-value. Read the summary's baseline, or the `detail` column, before acting.",
    "Staleness is judged only on sync-backed resources, against the MEDIAN sync time. Tables written by user activity (guest passes, entry logs, the snapshot jobs) are never flagged: quiet is not the same as broken.",
  ],
});

export const RESMAN_RESOURCES: readonly ResmanResource[] = [
  propertiesResource, buildingsResource, floorplansResource, unitsResource,
  leasesResource, residentsResource, transactionsResource, workOrdersResource,
  mlgwAccountsResource, mlgwBillsResource, mlgwPaymentsResource,
  guestPassesResource, entryLogsResource, propertySnapshotsResource,
  unitSnapshotsResource, monitorFindingsResource,
];
