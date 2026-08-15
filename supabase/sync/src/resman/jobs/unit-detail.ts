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
import {
  isDeniedLease,
  isPendingLease,
  leaseBalanceFromLedger,
  mapLease,
  withoutBalance,
  withoutTermDates,
  type LeaseRowWithoutBalance,
  type LeaseRowWithoutTermDates,
} from "../scrapers/leases";
import { mapResidents } from "../scrapers/residents";
import {
  fetchBuildingFloorplans,
  isTerminalLeaseStatus,
  scrapeLeaseByPersonLeaseId,
  scrapeLeaseLedgerOnly,
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

/**
 * Stamp `synced_at` on rows whose mapper doesn't set it.
 *
 * `synced_at timestamptz default now()` only fires on INSERT — an
 * `ON CONFLICT DO UPDATE` never re-applies a column default. So a table seeded
 * here but refreshed every run froze its `synced_at` at the moment its first
 * row appeared, while the data stayed current. That is what made the admin
 * pages report a sync weeks old. Buildings and floorplans were affected;
 * the residents/leases/vehicles mappers already set it themselves.
 */
function stampSynced(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const syncedAt = new Date().toISOString();
  for (const row of rows) row.synced_at = syncedAt;
  return rows;
}

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
  /** Units whose page-only columns (floorplan, pets, affordable, country) were written. */
  unitsEnriched: number;
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

/** A scraped tri-state flag: true/false as read, null when the page omitted it. */
function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * The country line of the unit's parsed address ("United States"), or null when
 * the address block had only street and city/state/zip.
 */
function unitCountry(value: unknown): string | null {
  const address = dict(value);
  if (address === null) return null;
  const country = address["country"];
  return typeof country === "string" && country.trim().length > 0 ? country.trim() : null;
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

  // Accumulators. (Almost every unit-row field is owned by the all-units /
  // unit-info jobs; this pass seeds buildings/floorplans, the lease/resident/
  // ledger tables, and the four unit columns only the unit PAGE carries.)
  const unitRows: Array<Record<string, unknown>> = [];
  const leaseRows: LeaseRowWithoutBalance[] = [];
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
    let floorplanId = "";
    if (floorplan) {
      const fid = str(floorplan, "id");
      if (fid.length > 0) {
        floorplanId = fid;
        seedFloorplan({
          resman_floorplan_id: fid,
          resman_property_id: propertyId,
          name: str(floorplan, "name"),
          description: str(floorplan, "description"),
          square_feet: numOrNull(floorplan["squareFootage"]),
        });
      }
    }

    // Four unit columns nothing else writes. The All-Units CSV and the
    // unit-info report — which own every other unit field — carry none of
    // them, so they sat empty on all 891 units while this scrape read them off
    // the unit page every run and dropped them on the floor.
    //
    // Every key is always present, even as null: PostgREST builds one
    // statement from the union of keys in a batch, so a key that appears on
    // only some rows resets the column to its default on the rest. Writing
    // null here is safe precisely because this pass is the sole writer.
    unitRows.push({
      resman_unit_id: unitId,
      resman_floorplan_id: floorplanId.length > 0 ? floorplanId : null,
      pets_permitted: boolOrNull(data["petsPermitted"]),
      affordable_unit: boolOrNull(data["affordableUnit"]),
      country: unitCountry(data["address"]),
    });

    const unitNumber = str(data, "unitNumber");
    const leaseDicts = dictArray(data["leases"]);
    let mostRecentAssigned = false;
    for (const leaseData of leaseDicts) {
      const isMostRecent = !isDeniedLease(leaseData) && !isPendingLease(leaseData) && !mostRecentAssigned;
      if (isMostRecent) mostRecentAssigned = true;

      const leaseRow = mapLease(leaseData, { unitId, unitNumber, propertyId, isMostRecent });
      // A one-time terminal capture carries its proof; skeletons stay unstamped.
      if (leaseData._deepCaptured === true) leaseRow.deep_synced_at = new Date().toISOString();

      // Balance is STRIPPED here, never written. This pass reads the lease
      // history table and the resident page WITHOUT the ledger, so it has no
      // way to know a balance — and mapLease would emit null, which is how
      // every balance in the mirror got wiped. The deep pass owns this column.
      leaseRows.push(withoutBalance(leaseRow));

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
    upsertMirror(supabase, "resman_buildings", stampSynced([...buildingsById.values()]), { conflictColumn: "resman_building_id" }),
    upsertMirror(supabase, "resman_floorplans", stampSynced([...floorplansById.values()]), { conflictColumn: "resman_floorplan_id" }),
    upsertMirror(supabase, "resman_leases", asRows(leaseRows), { conflictColumn: "resman_lease_id" }),
  ]);
  // Units join wave 2: `resman_floorplan_id` points at resman_floorplans, so
  // those rows have to land first. No delete-missing — this pass only enriches
  // units the roster job owns and must never remove one.
  const [uOut, rOut] = await Promise.all([
    upsertMirror(supabase, "resman_units", unitRows, { conflictColumn: "resman_unit_id" }),
    upsertMirror(supabase, "resman_residents", asRows(residentRows), {
      conflictColumn: "resman_person_lease_id",
    }),
  ]);
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
    unitsEnriched: uOut.upserted,
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
  /** Finished applications that needed no request at all this run. */
  skipped: number;
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
  status: string | null;
  deep_synced_at: string | null;
}

/**
 * Lease statuses that are an APPLICATION in flight rather than a residency.
 *
 * These leases are, by definition, neither `is_current_lease` nor
 * `is_most_recent_lease` — the unit they are for usually still has a sitting
 * resident whose lease holds both flags — so the original current/most-recent
 * filter never scraped a single one. That left every pending application in the
 * mirror as a bare shell: 63 rows on this property with a status and nothing
 * else, no application_date, no leasing_agent, no move_in_date. The manager
 * app's Pipeline board is built on exactly those fields, so it rendered them as
 * anonymous rows that could not say who the prospect was or who owned the deal.
 *
 * `ilike` patterns, matched server-side, so "Pending Renewal" is caught by
 * "pending%" without a second entry.
 */
export const APPLICATION_LEASE_STATUS_PATTERNS = ["pending%", "approved%", "applicant%", "prospect%"];

/**
 * Statuses whose lease FIELDS are still moving, so the full scrape re-runs on
 * every sync. These are exactly the leases where somebody is still living in
 * the unit, or still negotiating the terms of doing so:
 *
 *   current          — a sitting residency; rent, dates and balance all move
 *   pending renewal  — terms under negotiation
 *   notice           — "Notice to Vacate": move_out_date, notice_given_date and
 *                      reason_for_leaving are being written right now
 *   eviction         — "Under Eviction" (NOT "Evicted", which is terminal —
 *                      the substring is chosen to exclude it); the set-out date
 *                      lands on these while the case runs
 *   month to month   — a live residency on a rolling term
 *
 * The move-out reporting reads move_out_date and reason_for_leaving off the
 * notice/eviction rows, so freezing them after one capture would quietly stale
 * that data — which is why they re-read in full rather than ledger-only.
 *
 * Every other status is captured in full exactly ONCE and then refreshed
 * ledger-only (see leaseScrapeTier). Substring match against the lowercased
 * ResMan status.
 */
export const ALWAYS_FULL_SCRAPE_STATUSES = [
  "current",
  "pending renewal",
  "notice",
  "eviction",
  "month to month",
];

/** The PostgREST `or=` expression selecting leases worth reading at all. */
export function qualifyingLeaseOrFilter(): string {
  return [
    "is_current_lease.eq.true",
    "is_most_recent_lease.eq.true",
    ...APPLICATION_LEASE_STATUS_PATTERNS.map((p) => `status.ilike.${p}`),
    // Anything never deep-captured earns one full scrape, whatever its status.
    "deep_synced_at.is.null",
  ].join(",");
}

/**
 * Statuses for an application that NEVER became a tenancy. Once captured they
 * are finished — there is no ledger that can move, because no rent was ever
 * charged against them — so they are skipped entirely on later runs.
 *
 * Contrast the ended-tenancy statuses (Former, Evicted, Renewed…), which do
 * keep a moving ledger: collections, write-offs and final-account activity
 * continue for months after the resident has gone. Those fall through to the
 * ledger tier.
 *
 * ORDER MATTERS: "Pending Renewal" contains "pending", so this list is only
 * consulted AFTER ALWAYS_FULL_SCRAPE_STATUSES has had its say. A renewal is a
 * live negotiation, not a dead application.
 */
export const NO_LEDGER_STATUSES = [
  "pending",
  "denied",
  "cancel",
  "approved",
  "applicant",
  "prospect",
];

export type LeaseScrapeTier = "full" | "ledger" | "skip";

/**
 * How much of a lease to re-read this run.
 *
 * `full`   — never deep-captured (nothing is known beyond the shallow
 *            skeleton), or somebody still lives in the unit so the fields move.
 * `ledger` — captured, tenancy ended: the money still moves, nothing else does.
 * `skip`   — captured, and it was an application that never became a tenancy.
 *            Finished. No further requests, ever.
 *
 * The `deep_synced_at === null` check comes first and has no status condition,
 * which is what makes "every lease type is scraped at least once" true.
 */
export function leaseScrapeTier(lease: {
  status: string | null;
  deep_synced_at: string | null;
}): LeaseScrapeTier {
  if (lease.deep_synced_at === null) return "full";
  const s = (lease.status ?? "").toLowerCase();
  if (ALWAYS_FULL_SCRAPE_STATUSES.some((k) => s.includes(k))) return "full";
  if (NO_LEDGER_STATUSES.some((k) => s.includes(k))) return "skip";
  // Ended tenancies, plus any status ResMan invents that we do not recognize:
  // two requests to keep the money current is the safe default.
  return "ledger";
}

/**
 * Page every lease worth reading: current/most-recent residencies, in-flight
 * applications, and anything never deep-captured. `leaseScrapeTier` then
 * decides how much of each to re-read.
 */
async function loadQualifyingLeases(
  supabase: ServiceClient,
  propertyId: string,
): Promise<QualifyingLease[]> {
  const leases: QualifyingLease[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("resman_leases")
      .select(
        "resman_lease_id, resman_unit_id, unit_number, is_most_recent_lease, is_current_lease, status, deep_synced_at",
      )
      .eq("resman_property_id", propertyId)
      .or(qualifyingLeaseOrFilter())
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
      leases: 0, scraped: 0, failed: 0, skipped: 0, leasesUpserted: 0, transactions: 0,
      residents: 0, vehicles: 0, employment: 0, insurance: 0, addresses: 0,
      alternateContacts: 0,
    };
  }

  let scraped = 0;
  let failed = 0;
  let started = 0;
  let done = 0;

  // Finished applications cost nothing: drop them before the loop so they are
  // not counted, logged or requested.
  const skipped = leases.filter((l) => leaseScrapeTier(l) === "skip").length;
  const work = leases.filter((l) => leaseScrapeTier(l) !== "skip");
  const total = work.length;
  const fullCount = work.filter((l) => leaseScrapeTier(l) === "full").length;
  log(
    `[lease-details] ${total} lease${total === 1 ? "" : "s"} to read — ` +
      `${fullCount} full (fields + residents + tabs + ledger), ` +
      `${total - fullCount} ledger-only; ` +
      `${skipped} finished application${skipped === 1 ? "" : "s"} skipped; concurrency ${concurrency}…`,
  );
  const scrapeResults = await mapWithConcurrency(work, concurrency, async (lease) => {
    const label = lease.unit_number || lease.resman_lease_id;
    const tier = leaseScrapeTier(lease);
    started += 1;
    log(`[lease-details]   → [${started}/${total}] ${label} (${tier})`);
    try {
      if (tier === "ledger") {
        // Already captured and settled: only the money still moves. Two
        // requests instead of ~13 — see scrapeLeaseLedgerOnly.
        const ledger = await scrapeLeaseLedgerOnly(lease.resman_lease_id, http);
        scraped += 1;
        done += 1;
        log(`[lease-details] ✓ [${done}/${total}] ${label} — ledger only, ${ledger.length} entries`);
        return { lease, tier, data: { ledger } as Record<string, unknown> };
      }
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
      return { lease, tier, data };
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

  // Not ResmanLeaseRow: the lease term is stripped before write. This job reads
  // the lease DETAIL page, which does not carry start/end dates — see
  // withoutTermDates(). Every row here goes through it, which is what keeps the
  // upsert batch uniform.
  const leaseRows: LeaseRowWithoutTermDates[] = [];
  /**
   * Balance-only lease rows for the ledger tier, written as their OWN upsert.
   *
   * A ledger-tier pass read no lease fields, so it must not join the full
   * batch: PostgREST builds one statement from the union of a batch's keys, and
   * a two-column row mixed in with full ones would write nulls over everything
   * else (the same trap withoutTermDates exists for). As a separate batch the
   * statement's column set is exactly {resman_lease_id, balance}, so nothing
   * else is touched. These lease ids were read from this table moments earlier,
   * so the ON CONFLICT branch is the only one that ever fires.
   */
  const balanceRows: Array<{ resman_lease_id: string; balance: number }> = [];
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
    const { lease, tier, data } = entry;
    const unitId = lease.resman_unit_id ?? str(data, "unitId");
    const leaseId = lease.resman_lease_id;

    // A ledger-only pass read NO lease fields and NO residents. Mapping its
    // empty dict would write blanks over the very data the first full capture
    // went and got — the mapper coerces absent keys to ""/null and the upsert
    // overwrites. So it contributes transactions and nothing else.
    const leaseLedger = mapLedgerRows(dictArray(data["ledger"]), { leaseId, unitId, propertyId });

    if (tier === "ledger") {
      txRows.push(...leaseLedger);
      // The ledger is the whole reason this tier exists, so the lease's balance
      // must move with it. Only the two columns are sent — see balanceRows.
      balanceRows.push({ resman_lease_id: leaseId, balance: leaseBalanceFromLedger(leaseLedger) });
      continue;
    }

    const leaseRow = mapLease(data, {
      unitId,
      unitNumber: lease.unit_number,
      propertyId,
      isMostRecent: lease.is_most_recent_lease,
    });
    leaseRow.deep_synced_at = new Date().toISOString();
    // The detail page carries no Balance field, so mapLease always produced
    // null here. The ledger has it — see leaseBalanceFromLedger.
    leaseRow.balance = leaseBalanceFromLedger(leaseLedger);
    leaseRows.push(withoutTermDates(leaseRow));
    txRows.push(...leaseLedger);
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
  // Separate batch on purpose — see balanceRows.
  const bOut = await upsertMirror(supabase, "resman_leases", asRows(balanceRows), {
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
    leases: work.length,
    scraped,
    failed,
    skipped,
    leasesUpserted: lOut.upserted + bOut.upserted,
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
    units: 0, scraped: 0, failed: 0, unitsEnriched: 0, leases: 0, transactions: 0, residents: 0,
    vehicles: 0, employment: 0, insurance: 0, addresses: 0, alternateContacts: 0,
    buildings: 0, floorplans: 0,
  };
}
