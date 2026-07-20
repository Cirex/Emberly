/**
 * ResMan unit-detail deep-scrape job: authenticate → fetch the property's units
 * from Supabase → per-unit deep scrape (unit page + lease history + ledger +
 * residents/tabs) → map → upsert into resman_units (enrichment), resman_leases,
 * resman_transactions, resman_residents, and the resman_lease_* tab tables.
 *
 * Port of ResManUnitDetailSync.syncUnitDetails + applyDetailResult. The SwiftData
 * ModelContext is replaced by upsertMirror; per-unit fan-out uses a bounded pool
 * (sequential within a worker — ResMan returns error pages under high concurrency).
 *
 * Upserts are insert-or-update only (no delete-missing) — a partial scrape must
 * never wipe historical leases/transactions/residents.
 */
import { upsertMirror, type ServiceClient } from "../../db/client";
import type { ResManClient } from "../client";
import type { ResManCredentials } from "../config";
import { isAuthenticationRequired } from "../errors";
import { ResManScrapeHttp, mapWithConcurrency } from "../scrapers/http";
import { numOrNull, parseLedgerDate, str } from "../scrapers/parse";
import { mapLedgerRows } from "../scrapers/ledger";
import { isDeniedLease, isPendingLease, mapLease } from "../scrapers/leases";
import { mapResidents } from "../scrapers/residents";
import {
  fetchBuildingFloorplans,
  isTerminalLeaseStatus,
  scrapeLeaseByPersonLeaseId,
  scrapeUnit,
} from "../scrapers/unit-detail";
import { vehicleIdentityKey } from "../normalize";
import type {
  BuildingFloorplans,
  ResmanLeaseAddressRow,
  ResmanLeaseAlternateContactRow,
  ResmanLeaseEmploymentRow,
  ResmanLeaseInsuranceRow,
  ResmanLeaseRow,
  ResmanLeaseVehicleRow,
  ResmanResidentRow,
  ResmanTransactionRow,
} from "../scrapers/types";

/** Cast typed row DTOs to the loose upsert row shape at the DB boundary. */
const asRows = (rows: readonly unknown[]): Array<Record<string, unknown>> =>
  rows as Array<Record<string, unknown>>;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface SyncUnitDetailsParams {
  client: ResManClient;
  supabase: ServiceClient;
  propertyId: string;
  credentials?: ResManCredentials;
  concurrency?: number;
  /** Cap the number of units scraped (for a bounded test run). */
  unitLimit?: number;
  log?: (message: string) => void;
}

export interface SyncUnitDetailsResult {
  units: number;
  scraped: number;
  failed: number;
  leases: number;
  transactions: number;
  residents: number;
  vehicles: number;
  employment: number;
  insurance: number;
  addresses: number;
  alternateContacts: number;
  buildings: number;
  floorplans: number;
}

type Dict = Record<string, unknown>;

function dict(value: unknown): Dict | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : null;
}

function dictArray(value: unknown): Dict[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Dict => v !== null && typeof v === "object");
}

/**
 * Page the property's units into { resman_unit_id, number }[].
 *
 * Ordered occupancy_status ascending ("Notice" < "Occupied" < "Vacant"), so
 * units with residents come first and Vacant units sort last. A full sweep
 * scrapes every unit regardless, but this makes a bounded run (`unitLimit`) or
 * an interrupted run land on units that actually have leases/residents rather
 * than a leading block of empty vacant units.
 */
async function loadUnits(
  supabase: ServiceClient,
  propertyId: string,
): Promise<Array<{ resman_unit_id: string; number: string }>> {
  const units: Array<{ resman_unit_id: string; number: string }> = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("resman_units")
      .select("resman_unit_id, number")
      .eq("resman_property_id", propertyId)
      .order("occupancy_status", { ascending: true, nullsFirst: false })
      .order("number", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`read resman_units failed: ${error.message}`);
    const batch = (data ?? []) as unknown as Array<{ resman_unit_id: string; number: string }>;
    units.push(...batch);
    if (batch.length < pageSize) break;
  }
  return units;
}


/**
 * Set of lease ids whose STORED status is already terminal — i.e. leases we have
 * already captured in their archived state. These are skipped on resync. A lease
 * whose stored status is still non-terminal (including one that only now went
 * terminal in the source) is intentionally absent, so it is synced once more to
 * record the terminal state before it qualifies to be skipped.
 */
async function loadArchivedLeaseIds(
  supabase: ServiceClient,
  propertyId: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("resman_leases")
      .select("resman_lease_id, status, deep_synced_at")
      .eq("resman_property_id", propertyId)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`read resman_leases failed: ${error.message}`);
    const batch = (data ?? []) as unknown as Array<{
      resman_lease_id: string;
      status: string | null;
      deep_synced_at: string | null;
    }>;
    for (const row of batch) {
      // Terminal status alone is not "captured" — the shallow pass writes
      // terminal-status skeletons. Only a lease whose children were actually
      // synced (deep_synced_at set) has earned the skip.
      if (isTerminalLeaseStatus(row.status ?? "") && row.deep_synced_at !== null) {
        ids.add(row.resman_lease_id);
      }
    }
    if (batch.length < pageSize) break;
  }
  return ids;
}

export async function syncUnitDetails(params: SyncUnitDetailsParams): Promise<SyncUnitDetailsResult> {
  const { client, supabase, propertyId } = params;
  const log = params.log ?? (() => {});
  const concurrency = params.concurrency ?? 6;

  log(`[unit-detail] authenticating…`);
  await client.ensureAuthenticated(params.credentials);
  const http = new ResManScrapeHttp(client);

  // The two DB reads and the network lookup are independent — run them together.
  log(`[unit-detail] loading units + archived leases + floorplan lookup…`);
  const [allUnits, archivedLeaseIds, floorplansOutcome] = await Promise.all([
    loadUnits(supabase, propertyId),
    loadArchivedLeaseIds(supabase, propertyId),
    fetchBuildingFloorplans(propertyId, http).then(
      (f) => ({ ok: true as const, floorplans: f }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);

  // Skip non-UUID (mock/seed) unit ids — ResMan returns 501 for fake ids.
  let units = allUnits.filter((u) => UUID_RE.test(u.resman_unit_id));
  if (params.unitLimit !== undefined) units = units.slice(0, params.unitLimit);
  if (units.length === 0) {
    log(`[unit-detail] no scrapeable units for property ${propertyId}`);
    return emptyResult();
  }
  log(`[unit-detail] ${units.length} unit${units.length === 1 ? "" : "s"} to scrape (of ${allUnits.length} in DB)`);
  log(`[unit-detail] ${archivedLeaseIds.size} lease${archivedLeaseIds.size === 1 ? "" : "s"} already archived (skipped; a lease going terminal is synced once more first)`);

  let floorplans: BuildingFloorplans | null = null;
  if (floorplansOutcome.ok) {
    floorplans = floorplansOutcome.floorplans;
    log(`[unit-detail] lookup: ${floorplans.buildings.length} buildings, ${floorplans.floorplans.length} floorplans`);
  } else {
    log(`[unit-detail] buildingFloorplans fetch failed: ${(floorplansOutcome.error as Error).message}`);
  }

  let scraped = 0;
  let failed = 0;
  let started = 0;
  let done = 0;
  const total = units.length;
  log(`[unit-detail] scraping ${total} unit${total === 1 ? "" : "s"} (concurrency ${concurrency})…`);
  const scrapeResults = await mapWithConcurrency(units, concurrency, async (unit) => {
    const label = unit.number || unit.resman_unit_id;
    started += 1;
    log(`[unit-detail]   → [${started}/${total}] ${label}`);
    try {
      const data = await scrapeUnit(unit.resman_unit_id, http, {
        cachedFloorplans: floorplans ?? undefined,
        knownPropertyId: propertyId,
        archivedLeaseIds,
      });
      scraped += 1;
      const leaseCount = Array.isArray(data.leases) ? data.leases.length : 0;
      const skipped = typeof data._skippedArchivedLeases === "number" ? data._skippedArchivedLeases : 0;
      const skipNote = skipped > 0 ? `, ${skipped} archived skipped` : "";
      done += 1;
      log(`[unit-detail] ✓ [${done}/${total}] ${label} — ${leaseCount} lease${leaseCount === 1 ? "" : "s"}${skipNote}`);
      return data;
    } catch (error) {
      // A mid-run session expiry (authenticationRequired) must abort the whole
      // job, not count as one more failed unit — otherwise it grinds through
      // every remaining unit re-failing, and a partial success would look like
      // sparse data. Fail loud; the next scheduled run re-authenticates fresh.
      if (isAuthenticationRequired(error)) throw error;
      failed += 1;
      done += 1;
      log(`[unit-detail] ✗ [${done}/${total}] ${label} — FAILED: ${(error as Error).message}`);
      return null;
    }
  });
  log(`[unit-detail] scrape complete: ${scraped} ok, ${failed} failed — upserting…`);

  // If EVERY unit failed, this is not a successful empty run — it is a total
  // outage (expired session, ResMan down, network). Upserting the resulting
  // empty arrays is a no-op, so without this the job would return normally and
  // the Coolify cron would see a green run while nothing was scraped. Fail loud.
  if (total > 0 && failed === total) {
    throw new Error(`[unit-detail] all ${total} unit scrapes failed — aborting run (non-zero exit)`);
  }

  // Accumulators. (Unit-row fields are owned by the all-units / unit-info jobs;
  // this pass only seeds buildings/floorplans and the lease/resident/ledger tables.)
  const leaseRows: ResmanLeaseRow[] = [];
  const txRows: ResmanTransactionRow[] = [];
  const residentRows: ResmanResidentRow[] = [];
  const vehicleRows: ResmanLeaseVehicleRow[] = [];
  const seenVehicles = new Set<string>();
  const employmentRows: ResmanLeaseEmploymentRow[] = [];
  const insuranceRows: ResmanLeaseInsuranceRow[] = [];
  const addressRows: ResmanLeaseAddressRow[] = [];
  const altContactRows: ResmanLeaseAlternateContactRow[] = [];
  const buildingsById = new Map<string, Record<string, unknown>>();
  const floorplansById = new Map<string, Record<string, unknown>>();

  const seedBuilding = (id: string, name: string) => {
    if (id.length > 0 && !buildingsById.has(id)) {
      buildingsById.set(id, { resman_building_id: id, resman_property_id: propertyId, name });
    }
  };
  const seedFloorplan = (row: Record<string, unknown>) => {
    const id = String(row.resman_floorplan_id ?? "");
    if (id.length > 0 && !floorplansById.has(id)) floorplansById.set(id, row);
  };

  // Seed buildings/floorplans from the property-wide lookup.
  if (floorplans) {
    for (const b of floorplans.buildings) seedBuilding(b.BuildingID, b.Name);
    for (const f of floorplans.floorplans) {
      seedFloorplan({
        resman_floorplan_id: f.floorplanId,
        resman_property_id: propertyId,
        name: f.Name,
        description: f.Description ?? "",
        square_feet: f.SquareFootage ?? null,
      });
    }
  }

  for (const data of scrapeResults) {
    if (data === null) continue;
    const unitId = str(data, "unitId");

    // Seed building/floorplan from the unit itself so the FK targets exist.
    const building = dict(data["building"]);
    if (building) seedBuilding(str(building, "id"), str(building, "name"));
    const floorplan = dict(data["floorplan"]);
    if (floorplan) {
      const fid = str(floorplan, "id");
      if (fid.length > 0) {
        seedFloorplan({
          resman_floorplan_id: fid,
          resman_property_id: propertyId,
          name: str(floorplan, "name"),
          description: str(floorplan, "description"),
          square_feet: numOrNull(floorplan["squareFootage"]),
        });
      }
    }

    const unitNumber = str(data, "unitNumber");
    const leaseDicts = dictArray(data["leases"]);
    let mostRecentAssigned = false;
    for (const leaseData of leaseDicts) {
      const isMostRecent = !isDeniedLease(leaseData) && !isPendingLease(leaseData) && !mostRecentAssigned;
      if (isMostRecent) mostRecentAssigned = true;

      const leaseRow = mapLease(leaseData, { unitId, unitNumber, propertyId, isMostRecent });
      // A one-time terminal capture carries its proof; skeletons stay unstamped.
      if (leaseData._deepCaptured === true) leaseRow.deep_synced_at = new Date().toISOString();
      leaseRows.push(leaseRow);

      const leaseId = str(leaseData, "leaseId");
      txRows.push(...mapLedgerRows(dictArray(leaseData["ledger"]), { leaseId, unitId, propertyId }));

      const mapped = mapResidents(dictArray(leaseData["residents"]), { leaseId });
      residentRows.push(...mapped.residents);
      for (const v of mapped.vehicles) {
        // The same physical car often rides on several person-leases of one
        // unit — one row per unit per vehicle is what "vehicles on file" means.
        const key = vehicleIdentityKey(unitId, v);
        if (!seenVehicles.has(key)) {
          seenVehicles.add(key);
          vehicleRows.push(v);
        }
      }
      employmentRows.push(...mapped.employment);
      insuranceRows.push(...mapped.insurance);
      addressRows.push(...mapped.addresses);
      altContactRows.push(...mapped.alternateContacts);
    }
  }

  // Upsert in FK-safe waves, parallelizing independent tables within each wave:
  //   wave 1: buildings, floorplans, leases  (leases key on property/unit, which
  //           already exist; no dependency on buildings/floorplans)
  //   wave 2: residents                      (FK → leases)
  //   wave 3: transactions + the 5 lease-tab tables (FK → leases / residents,
  //           all present by now) — mutually independent
  const [bOut, fOut, lOut] = await Promise.all([
    upsertMirror(supabase, "resman_buildings", [...buildingsById.values()], { conflictColumn: "resman_building_id" }),
    upsertMirror(supabase, "resman_floorplans", [...floorplansById.values()], { conflictColumn: "resman_floorplan_id" }),
    upsertMirror(supabase, "resman_leases", asRows(leaseRows), { conflictColumn: "resman_lease_id" }),
  ]);
  const rOut = await upsertMirror(supabase, "resman_residents", asRows(residentRows), {
    conflictColumn: "resman_person_lease_id",
  });
  const [tOut, vOut, eOut, iOut, aOut, cOut] = await Promise.all([
    upsertMirror(supabase, "resman_transactions", asRows(txRows), { conflictColumn: "resman_ledger_entry_id" }),
    upsertMirror(supabase, "resman_lease_vehicles", asRows(vehicleRows), { conflictColumn: "resman_vehicle_id" }),
    upsertMirror(supabase, "resman_lease_employment", asRows(employmentRows), { conflictColumn: "resman_employment_id" }),
    upsertMirror(supabase, "resman_lease_insurance", asRows(insuranceRows), { conflictColumn: "resman_insurance_id" }),
    upsertMirror(supabase, "resman_lease_addresses", asRows(addressRows), { conflictColumn: "resman_address_id" }),
    upsertMirror(supabase, "resman_lease_alternate_contacts", asRows(altContactRows), { conflictColumn: "resman_contact_id" }),
  ]);

  const result: SyncUnitDetailsResult = {
    units: units.length,
    scraped,
    failed,
    leases: lOut.upserted,
    transactions: tOut.upserted,
    residents: rOut.upserted,
    vehicles: vOut.upserted,
    employment: eOut.upserted,
    insurance: iOut.upserted,
    addresses: aOut.upserted,
    alternateContacts: cOut.upserted,
    buildings: bOut.upserted,
    floorplans: fOut.upserted,
  };
  log(`[unit-detail] complete: ${JSON.stringify(result)}`);
  return result;
}

// ---------------------------------------------------------------------------
// Deep per-lease pass: ledgers + resident details/tabs + full lease fields.
// Ports syncAllLedgers + syncAllResidentTabs + syncDeepLeaseHistory — each Swift
// pass iterates the current/most-recent leases and deep-scrapes them; a single
// full per-lease scrape (fetchTabsAndLedger=true) covers all three.
// ---------------------------------------------------------------------------

export interface SyncLeaseDetailsParams {
  client: ResManClient;
  supabase: ServiceClient;
  propertyId: string;
  credentials?: ResManCredentials;
  concurrency?: number;
  /** Cap the number of leases scraped (for a bounded test run). */
  leaseLimit?: number;
  log?: (message: string) => void;
}

export interface SyncLeaseDetailsResult {
  leases: number;
  scraped: number;
  failed: number;
  leasesUpserted: number;
  transactions: number;
  residents: number;
  vehicles: number;
  employment: number;
  insurance: number;
  addresses: number;
  alternateContacts: number;
}

interface QualifyingLease {
  resman_lease_id: string;
  resman_unit_id: string | null;
  unit_number: string;
  is_most_recent_lease: boolean;
}

/** Page the property's current/most-recent leases (the Swift qualifying filter). */
async function loadQualifyingLeases(
  supabase: ServiceClient,
  propertyId: string,
): Promise<QualifyingLease[]> {
  const leases: QualifyingLease[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("resman_leases")
      .select("resman_lease_id, resman_unit_id, unit_number, is_most_recent_lease, is_current_lease")
      .eq("resman_property_id", propertyId)
      .or("is_current_lease.eq.true,is_most_recent_lease.eq.true")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`read resman_leases failed: ${error.message}`);
    const batch = (data ?? []) as unknown as QualifyingLease[];
    leases.push(...batch);
    if (batch.length < pageSize) break;
  }
  return leases;
}

export async function syncLeaseDetails(params: SyncLeaseDetailsParams): Promise<SyncLeaseDetailsResult> {
  const { client, supabase, propertyId } = params;
  const log = params.log ?? (() => {});
  const concurrency = params.concurrency ?? 6;

  log(`[lease-details] authenticating…`);
  await client.ensureAuthenticated(params.credentials);
  const http = new ResManScrapeHttp(client);

  log(`[lease-details] loading qualifying leases from DB…`);
  let leases = await loadQualifyingLeases(supabase, propertyId);
  if (params.leaseLimit !== undefined) leases = leases.slice(0, params.leaseLimit);
  if (leases.length === 0) {
    log(`[lease-details] no current/most-recent leases for property ${propertyId}`);
    return {
      leases: 0, scraped: 0, failed: 0, leasesUpserted: 0, transactions: 0, residents: 0,
      vehicles: 0, employment: 0, insurance: 0, addresses: 0, alternateContacts: 0,
    };
  }

  let scraped = 0;
  let failed = 0;
  let started = 0;
  let done = 0;
  const total = leases.length;
  log(`[lease-details] scraping ${total} lease${total === 1 ? "" : "s"} (ledger + residents + tabs, concurrency ${concurrency})…`);
  const scrapeResults = await mapWithConcurrency(leases, concurrency, async (lease) => {
    const label = lease.unit_number || lease.resman_lease_id;
    started += 1;
    log(`[lease-details]   → [${started}/${total}] ${label}`);
    try {
      const data = await scrapeLeaseByPersonLeaseId(
        lease.resman_lease_id,
        propertyId,
        lease.resman_unit_id ?? "",
        http,
        true,
      );
      scraped += 1;
      const txCount = Array.isArray(data.ledger) ? data.ledger.length : 0;
      const resCount = Array.isArray(data.residents) ? data.residents.length : 0;
      done += 1;
      log(`[lease-details] ✓ [${done}/${total}] ${label} — ${resCount} resident${resCount === 1 ? "" : "s"}, ${txCount} ledger`);
      return { lease, data };
    } catch (error) {
      // See the unit-detail loop above: a mid-run session expiry aborts the job
      // rather than silently degrading to sparse/empty data.
      if (isAuthenticationRequired(error)) throw error;
      failed += 1;
      done += 1;
      log(`[lease-details] ✗ [${done}/${total}] ${label} — FAILED: ${(error as Error).message}`);
      return null;
    }
  });
  log(`[lease-details] scrape complete: ${scraped} ok, ${failed} failed — upserting…`);

  const leaseRows: ResmanLeaseRow[] = [];
  const txRows: ResmanTransactionRow[] = [];
  const residentRows: ResmanResidentRow[] = [];
  const vehicleRows: ResmanLeaseVehicleRow[] = [];
  const seenVehicles = new Set<string>();
  const employmentRows: ResmanLeaseEmploymentRow[] = [];
  const insuranceRows: ResmanLeaseInsuranceRow[] = [];
  const addressRows: ResmanLeaseAddressRow[] = [];
  const altContactRows: ResmanLeaseAlternateContactRow[] = [];

  for (const entry of scrapeResults) {
    if (entry === null) continue;
    const { lease, data } = entry;
    const unitId = lease.resman_unit_id ?? str(data, "unitId");
    const leaseRow = mapLease(data, {
      unitId,
      unitNumber: lease.unit_number,
      propertyId,
      isMostRecent: lease.is_most_recent_lease,
    });
    leaseRow.deep_synced_at = new Date().toISOString();
    leaseRows.push(
      leaseRow,
    );
    const leaseId = lease.resman_lease_id;
    txRows.push(...mapLedgerRows(dictArray(data["ledger"]), { leaseId, unitId, propertyId }));
    const mapped = mapResidents(dictArray(data["residents"]), { leaseId });
    residentRows.push(...mapped.residents);
    for (const v of mapped.vehicles) {
      const key = vehicleIdentityKey(unitId, v);
      if (!seenVehicles.has(key)) {
        seenVehicles.add(key);
        vehicleRows.push(v);
      }
    }
    employmentRows.push(...mapped.employment);
    insuranceRows.push(...mapped.insurance);
    addressRows.push(...mapped.addresses);
    altContactRows.push(...mapped.alternateContacts);
  }

  // FK-safe waves: leases → residents → (transactions + 5 tab tables, independent).
  const lOut = await upsertMirror(supabase, "resman_leases", asRows(leaseRows), {
    conflictColumn: "resman_lease_id",
  });
  const rOut = await upsertMirror(supabase, "resman_residents", asRows(residentRows), {
    conflictColumn: "resman_person_lease_id",
  });
  const [tOut, vOut, eOut, iOut, aOut, cOut] = await Promise.all([
    upsertMirror(supabase, "resman_transactions", asRows(txRows), { conflictColumn: "resman_ledger_entry_id" }),
    upsertMirror(supabase, "resman_lease_vehicles", asRows(vehicleRows), { conflictColumn: "resman_vehicle_id" }),
    upsertMirror(supabase, "resman_lease_employment", asRows(employmentRows), { conflictColumn: "resman_employment_id" }),
    upsertMirror(supabase, "resman_lease_insurance", asRows(insuranceRows), { conflictColumn: "resman_insurance_id" }),
    upsertMirror(supabase, "resman_lease_addresses", asRows(addressRows), { conflictColumn: "resman_address_id" }),
    upsertMirror(supabase, "resman_lease_alternate_contacts", asRows(altContactRows), { conflictColumn: "resman_contact_id" }),
  ]);

  const result: SyncLeaseDetailsResult = {
    leases: leases.length,
    scraped,
    failed,
    leasesUpserted: lOut.upserted,
    transactions: tOut.upserted,
    residents: rOut.upserted,
    vehicles: vOut.upserted,
    employment: eOut.upserted,
    insurance: iOut.upserted,
    addresses: aOut.upserted,
    alternateContacts: cOut.upserted,
  };
  log(`[lease-details] complete: ${JSON.stringify(result)}`);
  return result;
}

function emptyResult(): SyncUnitDetailsResult {
  return {
    units: 0, scraped: 0, failed: 0, leases: 0, transactions: 0, residents: 0,
    vehicles: 0, employment: 0, insurance: 0, addresses: 0, alternateContacts: 0,
    buildings: 0, floorplans: 0,
  };
}
