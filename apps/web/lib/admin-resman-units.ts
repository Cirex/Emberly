import { createUntypedAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";
import type { ResmanWorkOrderRow } from "@/lib/admin-resman-work-orders";

/**
 * Admin data-access for the ResMan/PM mirror tables (resman_units), for display in
 * the web admin. Read-only, service-role (RLS-bypassing) — the same pattern as
 * the other admin-*.ts helpers. These rows are populated by the sync worker
 * (supabase/sync); until it runs, the tables are empty and pages render the
 * empty state.
 */

export type ResmanOccupancy = "Occupied" | "Vacant" | "Notice";

export type ResmanUnitRow = {
  resman_unit_id: string;
  number: string;
  classification: string;
  occupancy_status: ResmanOccupancy | null;
  lease_status: string | null;
  tenant_names: string[];
  bedrooms: number | null;
  bathrooms: number | null;
  market_rent: number | null;
  lease_rent: number | null;
  balance: number | null;
  times_late: number | null;
  lease_end_date: string | null;
  synced_at: string | null;
};

export type ResmanUnitsStats = {
  total: number;
  occupied: number;
  vacant: number;
  notice: number;
  withBalance: number;
  /** Distinct street codes across the portfolio (the "CW" in "1709 CW-1"). */
  streets: number;
  lastSyncedAt: string | null;
};

export type ResmanUnitsResult = {
  units: ResmanUnitRow[];
  total: number;
  page: number;
  limit: number;
  stats: ResmanUnitsStats;
  classificationOptions: string[];
};

const SELECT =
  "resman_unit_id, number, classification, occupancy_status, lease_status, tenant_names, bedrooms, bathrooms, market_rent, lease_rent, balance, times_late, lease_end_date, synced_at";

/**
 * The whole mirror (<1k rows) is fetched once per page load and filtered in
 * memory — the stats need a full pass anyway, and it lets search match tenant
 * names, which PostgREST can't do cleanly against a text[] column.
 */
export async function listResmanUnits(
  params: {
    occupancy?: ResmanOccupancy;
    classification?: string;
    /** Restrict to units carrying a balance (owed money). */
    hasBalance?: boolean;
    search?: string;
    page?: number;
    limit?: number;
  } = {},
): Promise<ResmanUnitsResult> {
  const supabase = createUntypedAdminClient();
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(200, Math.max(1, params.limit ?? 100));

  const rows: ResmanUnitRow[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from("resman_units")
      .select(SELECT)
      .order("number", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) {
      console.error("[admin/resman-units] Query error:", error);
      throw new Error("Failed to fetch units");
    }
    const chunk = (data ?? []) as unknown as ResmanUnitRow[];
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
  }

  const stats: ResmanUnitsStats = {
    total: rows.length,
    occupied: rows.filter((u) => u.occupancy_status === "Occupied").length,
    vacant: rows.filter((u) => u.occupancy_status === "Vacant").length,
    notice: rows.filter((u) => u.occupancy_status === "Notice").length,
    withBalance: rows.filter((u) => (u.balance ?? 0) > 0).length,
    streets: new Set(rows.map((u) => u.number.split(" ")[1]?.split("-")[0]).filter(Boolean)).size,
    lastSyncedAt: rows.reduce<string | null>(
      (max, u) => (u.synced_at && (!max || u.synced_at > max) ? u.synced_at : max),
      null,
    ),
  };
  const classificationOptions = [...new Set(rows.map((u) => u.classification).filter(Boolean))].sort();

  let filtered = rows;
  if (params.occupancy) filtered = filtered.filter((u) => u.occupancy_status === params.occupancy);
  if (params.classification) filtered = filtered.filter((u) => u.classification === params.classification);
  if (params.hasBalance) filtered = filtered.filter((u) => (u.balance ?? 0) > 0);
  const needle = params.search?.trim().toLowerCase();
  if (needle) {
    filtered = filtered.filter(
      (u) =>
        u.number.toLowerCase().includes(needle) ||
        u.tenant_names.some((n) => n.toLowerCase().includes(needle)),
    );
  }
  // The balance view is a worklist — biggest debt first. Everything else keeps
  // the familiar unit-number order.
  if (params.hasBalance) filtered = [...filtered].sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));

  const start = (page - 1) * limit;
  return {
    units: filtered.slice(start, start + limit),
    total: filtered.length,
    page,
    limit,
    stats,
    classificationOptions,
  };
}

// MARK: - Unit detail (unit + its leases / residents / recent ledger)

export type ResmanUnitFull = {
  resman_unit_id: string;
  number: string | null;
  occupancy_status: ResmanOccupancy | null;
  lease_status: string | null;
  classification: string | null;
  availability: string | null;
  floor: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  max_occupancy: number | null;
  market_rent: number | null;
  lease_rent: number | null;
  deposit_required: number | null;
  deposit_held: number | null;
  balance: number | null;
  current_month_balance: number | null;
  times_late: number | null;
  delinquency_reason: string | null;
  notes: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  lease_start_date: string | null;
  lease_end_date: string | null;
  move_in_date: string | null;
  move_out_date: string | null;
  lease_term: string | null;
  leasing_agent: string | null;
  tenant_names: string[];
  holding_unit: boolean | null;
  excluded_from_occupancy: boolean | null;
  pets_permitted: boolean | null;
  affordable_unit: boolean | null;
  hearing_accessible: boolean | null;
  mobility_accessible: boolean | null;
  visual_accessible: boolean | null;
  scraped_at: string | null;
  synced_at: string | null;
};

export type ResmanLeaseSummary = {
  resman_lease_id: string;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  move_in_date: string | null;
  move_out_date: string | null;
  resident_rent: number | null;
  balance: number | null;
  leasing_agent: string | null;
  is_current_lease: boolean | null;
  is_most_recent_lease: boolean | null;
};

export type ResmanResidentSummary = {
  resman_person_lease_id: string;
  resman_lease_id: string | null;
  first_name: string | null;
  last_name: string | null;
  is_primary: boolean | null;
  household_status: string | null;
  email: string | null;
  phone_numbers: string[] | null;
};

export type ResmanTransactionSummary = {
  resman_ledger_entry_id: string;
  date: string | null;
  transaction_type: string | null;
  ledger_description: string | null;
  reference: string | null;
  charges: number | null;
  credits: number | null;
  balance: number | null;
};

export type ResmanUnitDetail = {
  unit: ResmanUnitFull;
  leases: ResmanLeaseSummary[];
  residents: ResmanResidentSummary[];
  transactions: ResmanTransactionSummary[];
  workOrders: ResmanWorkOrderRow[];
  vehicles: ResmanVehicle[];
  /**
   * Guests are allowed unless an admin has banned someone at this unit from
   * issuing passes — the same guest_pass_bans rule the scanner app applies.
   */
  guestsAllowed: boolean;
  guestBans: number;
};

const UNIT_FULL_SELECT =
  "resman_unit_id, number, occupancy_status, lease_status, classification, availability, floor, bedrooms, bathrooms, max_occupancy, market_rent, lease_rent, deposit_required, deposit_held, balance, current_month_balance, times_late, delinquency_reason, notes, street, city, state, postal_code, country, lease_start_date, lease_end_date, move_in_date, move_out_date, lease_term, leasing_agent, tenant_names, holding_unit, excluded_from_occupancy, pets_permitted, affordable_unit, hearing_accessible, mobility_accessible, visual_accessible, scraped_at, synced_at";

const TRANSACTION_SUMMARY_SELECT =
  "resman_ledger_entry_id, date, transaction_type, ledger_description, reference, charges, credits, balance";

/**
 * The most recent ledger entries for a unit or a lease, newest first
 * (ledger_sequence desc, then date desc). Shared by the unit- and lease-detail
 * views, which differ only in the filter column and how many rows they show.
 */
function recentLedger(
  supabase: UntypedSupabase,
  filter: { resman_unit_id: string } | { resman_lease_id: string },
  limit: number,
) {
  const [[column, value]] = Object.entries(filter);
  return supabase
    .from("resman_transactions")
    .select(TRANSACTION_SUMMARY_SELECT)
    .eq(column, value)
    .order("ledger_sequence", { ascending: false, nullsFirst: false })
    .order("date", { ascending: false })
    .limit(limit);
}

/**
 * Full detail for one unit: the unit row plus its leases (deep-scrape),
 * residents on those leases, and the most recent ledger entries. Returns null
 * when the unit id is unknown.
 */
export async function getResmanUnitDetail(unitId: string): Promise<ResmanUnitDetail | null> {
  const supabase = createUntypedAdminClient();

  const { data: unitData, error: unitError } = await supabase
    .from("resman_units")
    .select(UNIT_FULL_SELECT)
    .eq("resman_unit_id", unitId)
    .maybeSingle();
  if (unitError) {
    console.error("[admin/resman-units] Detail query error:", unitError);
    throw new Error("Failed to fetch unit");
  }
  if (!unitData) return null;
  const unit = unitData as unknown as ResmanUnitFull;

  const [leaseRes, txRes, woRes, fpResidentsRes] = await Promise.all([
    supabase
      .from("resman_leases")
      .select(
        "resman_lease_id, status, start_date, end_date, move_in_date, move_out_date, resident_rent, balance, leasing_agent, is_current_lease, is_most_recent_lease",
      )
      .eq("resman_unit_id", unitId)
      .order("is_most_recent_lease", { ascending: false })
      .order("start_date", { ascending: false }),
    recentLedger(supabase, { resman_unit_id: unitId }, 25),
    supabase
      .from("resman_work_orders")
      .select(
        "resman_work_order_id, number, resman_unit_id, unit_number, status, category, title, technician, date_reported, date_completed, is_make_ready, callback_status",
      )
      .eq("resman_unit_id", unitId)
      .order("date_reported", { ascending: false, nullsFirst: false }),
    // First-party residents (scanner-side) keyed by unit number — the bridge
    // the guest_pass_bans rule hangs off, same join as the scanner API.
    unit.number?.trim()
      ? supabase.from("residents").select("id").eq("unit_id", unit.number.trim())
      : Promise.resolve({ data: [] as Array<{ id: string }> }),
  ]);
  const leases = (leaseRes.data ?? []) as unknown as ResmanLeaseSummary[];
  const transactions = (txRes.data ?? []) as unknown as ResmanTransactionSummary[];
  const workOrders = (woRes.data ?? []) as unknown as ResmanWorkOrderRow[];
  const fpResidentIds = ((fpResidentsRes.data ?? []) as Array<{ id: string }>).map((r) => r.id);

  const leaseIds = leases.map((l) => l.resman_lease_id);
  let residents: ResmanResidentSummary[] = [];
  if (leaseIds.length > 0) {
    const { data: residentData } = await supabase
      .from("resman_residents")
      .select(
        "resman_person_lease_id, resman_lease_id, first_name, last_name, is_primary, household_status, email, phone_numbers",
      )
      .in("resman_lease_id", leaseIds)
      .order("is_primary", { ascending: false });
    residents = (residentData ?? []) as unknown as ResmanResidentSummary[];
  }

  const personLeaseIds = residents.map((r) => r.resman_person_lease_id);
  const [vehicleRes, banRes] = await Promise.all([
    personLeaseIds.length > 0
      ? supabase
          .from("resman_lease_vehicles")
          .select(
            "resman_vehicle_id, resman_person_lease_id, make, model, year, color, license_plate, license_plate_state, parking_spot",
          )
          .in("resman_person_lease_id", personLeaseIds)
      : Promise.resolve({ data: [] }),
    fpResidentIds.length > 0
      ? supabase.from("guest_pass_bans").select("resident_id").in("resident_id", fpResidentIds)
      : Promise.resolve({ data: [] }),
  ]);
  const vehicles = (vehicleRes.data ?? []) as unknown as ResmanVehicle[];
  const guestBans = (banRes.data ?? []).length;

  return { unit, leases, residents, transactions, workOrders, vehicles, guestsAllowed: guestBans === 0, guestBans };
}

// MARK: - Lease detail (lease + residents-with-tabs + ledger)

export type ResmanLeaseFull = {
  resman_lease_id: string;
  resman_unit_id: string | null;
  unit_number: string | null;
  status: string | null;
  approval_status: string | null;
  application_date: string | null;
  signed_date: string | null;
  start_date: string | null;
  end_date: string | null;
  move_in_date: string | null;
  move_out_date: string | null;
  renewal_date: string | null;
  notice_given_date: string | null;
  leasing_agent: string | null;
  market_rent: number | null;
  resident_rent: number | null;
  hap_rent: number | null;
  monthly_charge: number | null;
  balance: number | null;
  collection_balance: number | null;
  reason_for_leaving: string | null;
  is_current_lease: boolean | null;
  is_most_recent_lease: boolean | null;
};

export type ResmanVehicle = {
  resman_vehicle_id: string;
  resman_person_lease_id: string;
  make: string | null;
  model: string | null;
  year: string | null;
  color: string | null;
  license_plate: string | null;
  license_plate_state: string | null;
  parking_spot: string | null;
};
export type ResmanEmployment = {
  resman_employment_id: string;
  resman_person_lease_id: string;
  employer_name: string | null;
  position: string | null;
  phone: string | null;
  other_income_source: string | null;
  monthly_income: number | null;
  other_income: number | null;
  start_date: string | null;
};
export type ResmanInsurance = {
  resman_insurance_id: string;
  resman_person_lease_id: string;
  provider: string | null;
  policy_number: string | null;
  policy_type: string | null;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  coverage_amount: number | null;
};
export type ResmanAddress = {
  resman_address_id: string;
  resman_person_lease_id: string;
  address_type: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  start_date: string | null;
  end_date: string | null;
};
export type ResmanAltContact = {
  resman_contact_id: string;
  resman_person_lease_id: string;
  name: string | null;
  relationship: string | null;
  phone: string | null;
  email: string | null;
  is_emergency_contact: boolean | null;
};

export type ResmanResidentWithTabs = ResmanResidentSummary & {
  vehicles: ResmanVehicle[];
  employment: ResmanEmployment[];
  insurance: ResmanInsurance[];
  addresses: ResmanAddress[];
  alternateContacts: ResmanAltContact[];
};

export type ResmanLeaseDetail = {
  lease: ResmanLeaseFull;
  residents: ResmanResidentWithTabs[];
  transactions: ResmanTransactionSummary[];
};

const LEASE_FULL_SELECT =
  "resman_lease_id, resman_unit_id, unit_number, status, approval_status, application_date, signed_date, start_date, end_date, move_in_date, move_out_date, renewal_date, notice_given_date, leasing_agent, market_rent, resident_rent, hap_rent, monthly_charge, balance, collection_balance, reason_for_leaving, is_current_lease, is_most_recent_lease";

/** Full detail for one lease: fields, residents with their per-person tabs, and ledger. */
export async function getResmanLeaseDetail(leaseId: string): Promise<ResmanLeaseDetail | null> {
  const supabase = createUntypedAdminClient();

  const { data: leaseData, error: leaseError } = await supabase
    .from("resman_leases")
    .select(LEASE_FULL_SELECT)
    .eq("resman_lease_id", leaseId)
    .maybeSingle();
  if (leaseError) {
    console.error("[admin/resman-units] Lease detail query error:", leaseError);
    throw new Error("Failed to fetch lease");
  }
  if (!leaseData) return null;
  const lease = leaseData as unknown as ResmanLeaseFull;

  const { data: residentData } = await supabase
    .from("resman_residents")
    .select(
      "resman_person_lease_id, resman_lease_id, first_name, last_name, is_primary, household_status, email, phone_numbers",
    )
    .eq("resman_lease_id", leaseId)
    .order("is_primary", { ascending: false });
  const residentRows = (residentData ?? []) as unknown as ResmanResidentSummary[];
  const personLeaseIds = residentRows.map((r) => r.resman_person_lease_id);

  let vehicles: ResmanVehicle[] = [];
  let employment: ResmanEmployment[] = [];
  let insurance: ResmanInsurance[] = [];
  let addresses: ResmanAddress[] = [];
  let alternateContacts: ResmanAltContact[] = [];
  if (personLeaseIds.length > 0) {
    const inIds = (table: string, cols: string) =>
      supabase.from(table).select(cols).in("resman_person_lease_id", personLeaseIds);
    const [v, e, i, a, c, tx] = await Promise.all([
      inIds("resman_lease_vehicles", "resman_vehicle_id, resman_person_lease_id, make, model, year, color, license_plate, license_plate_state, parking_spot"),
      inIds("resman_lease_employment", "resman_employment_id, resman_person_lease_id, employer_name, position, phone, other_income_source, monthly_income, other_income, start_date"),
      inIds("resman_lease_insurance", "resman_insurance_id, resman_person_lease_id, provider, policy_number, policy_type, status, start_date, end_date, coverage_amount"),
      inIds("resman_lease_addresses", "resman_address_id, resman_person_lease_id, address_type, street, city, state, postal_code, country, start_date, end_date"),
      inIds("resman_lease_alternate_contacts", "resman_contact_id, resman_person_lease_id, name, relationship, phone, email, is_emergency_contact"),
      recentLedger(supabase, { resman_lease_id: leaseId }, 200),
    ]);
    vehicles = (v.data ?? []) as unknown as ResmanVehicle[];
    employment = (e.data ?? []) as unknown as ResmanEmployment[];
    insurance = (i.data ?? []) as unknown as ResmanInsurance[];
    addresses = (a.data ?? []) as unknown as ResmanAddress[];
    alternateContacts = (c.data ?? []) as unknown as ResmanAltContact[];
    const transactions = (tx.data ?? []) as unknown as ResmanTransactionSummary[];

    const byPerson = <T extends { resman_person_lease_id: string }>(rows: T[], pid: string) =>
      rows.filter((r) => r.resman_person_lease_id === pid);
    const residents: ResmanResidentWithTabs[] = residentRows.map((r) => ({
      ...r,
      vehicles: byPerson(vehicles, r.resman_person_lease_id),
      employment: byPerson(employment, r.resman_person_lease_id),
      insurance: byPerson(insurance, r.resman_person_lease_id),
      addresses: byPerson(addresses, r.resman_person_lease_id),
      alternateContacts: byPerson(alternateContacts, r.resman_person_lease_id),
    }));
    return { lease, residents, transactions };
  }

  // No residents → still return the lease + its ledger.
  const { data: txData } = await recentLedger(supabase, { resman_lease_id: leaseId }, 200);
  return { lease, residents: [], transactions: (txData ?? []) as unknown as ResmanTransactionSummary[] };
}

