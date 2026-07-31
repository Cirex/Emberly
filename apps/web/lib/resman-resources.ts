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
  searchable: ["unit_number", "leasing_agent", "reason_for_leaving"],
  ranges: { start: "start_date", end: "end_date", move_out: "move_out_date", balance: "balance" },
  // `status` here is the FULL lease lifecycle (Current, Renewed, Evicted,
  // Former, Denied, …) — richer than units.lease_status, which the All-Units
  // report narrows to eight values.
  groupable: ["status", "approval_status", "is_current_lease", "is_most_recent_lease", "leasing_agent", "resman_property_id"],
  measures: ["market_rent", "resident_rent", "hap_rent", "monthly_charge", "balance", "collection_balance"],
  sortable: ["start_date", "end_date", "balance", "move_out_date"],
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
  },
  order: { column: "account_number", ascending: true },
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
  },
  order: { column: "paid_date", ascending: false },
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
  },
  order: { column: "created_at", ascending: false },
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
});

export const RESMAN_RESOURCES: readonly ResmanResource[] = [
  propertiesResource, buildingsResource, floorplansResource, unitsResource,
  leasesResource, residentsResource, transactionsResource, workOrdersResource,
  mlgwAccountsResource, mlgwBillsResource, mlgwPaymentsResource,
  guestPassesResource, entryLogsResource,
];
