/**
 * ResMan unit-detail deep scrape — the SCRAPE layer.
 *
 * Faithful port of the `private extension ResManUnitDetailScraper` static
 * methods (plus `fetchBuildingFloorplans`) and the module-private HTML parsing
 * helpers in
 * KrakenCore/Services/ResMan/ResManUnitDetailScraper.swift.
 *
 * These functions issue GETs through {@link ResManScrapeHttp} and return the
 * untyped `[String: Any]`-equivalent scrape dicts (`Record<string, unknown>`)
 * the mapper layer (`ledger.ts`, `leases.ts`, `residents.ts`) consumes. They do
 * NOT touch Supabase.
 *
 * Fidelity notes:
 *   - Swift `#"..."#` raw regexes become ordinary JS regex source strings; all
 *     patterns are run through `rmsFirstMatch`/`rmsMatches` from `./parse`, which
 *     compile with the `is`/`gis` flags (case-insensitive + dot-matches-newline)
 *     that Swift's `NSRegularExpression` cache used.
 *   - Swift `NSNull()` sentinels become `null`; `compact(...)` drops `null`,
 *     `undefined`, and empty strings (keeping `false`/`0`), matching the Swift
 *     `compact` which dropped only nil and empty strings.
 *   - Ordering is preserved 1:1: in `scrapeUnit` the unit page is fetched THEN
 *     lease history sequentially (the Swift comment warns that firing both in
 *     parallel doubles the per-worker connection count and makes ResMan serve
 *     generic error pages), and the per-lease loop is sequential. Per-resident
 *     and per-tab fan-out use `mapWithConcurrency` with modest bounds
 *     (sequential-within-worker) rather than Swift's unbounded task groups.
 */

import { ResManScrapingError } from "../errors";
import { titleCaseName } from "../normalize";
import {
  attr,
  dataURLEndpoints,
  endpointNamed,
  flFvPairs,
  hiddenInputs,
  intOrNull,
  normalizeDate,
  numOrNull,
  rmsFirstMatch,
  rmsMatches,
  stripTags,
  trimmedForCell,
  yesNo,
} from "./parse";
import { mapWithConcurrency, type ResManScrapeHttp } from "./http";
import type {
  BuildingFloorplans,
  BuildingLookup,
  FloorplanLookup,
} from "./types";

// MARK: - Concurrency bounds (modest, sequential-within-worker)

/** Max resident detail pages fetched at once within one lease. */
const RESIDENT_CONCURRENCY = 3;
/** Max per-resident tab endpoints fetched at once. */
const TAB_CONCURRENCY = 3;

// MARK: - Regex sources (ports of the Swift `#"..."#` patterns)

const TR_PATTERN = "<tr\\b[^>]*>(.*?)</tr>";
const TD_TH_PATTERN = "<t[dh]\\b[^>]*>(.*?)</t[dh]>";
const PROP_ID_QUERY = "propertyID=([0-9a-fA-F-]{36})";
const PROP_ID_JSON = "PropertyID[\"']?\\s*[:=]\\s*[\"']([0-9a-fA-F-]{36})";
const RESIDENT_DETAIL_UUID = "Residents/Detail/([0-9a-fA-F-]{36})";
const UNIT_TYPE_UUID = "UnitTypes/Detail/([0-9a-fA-F-]{36})";
const UNIT_LEASE_GROUP_UUID = "unitLeaseGroupID=([0-9a-fA-F-]{36})";
const RESIDENT_RADIO_PATTERN =
  "<input\\b([^>]*\\bclass=[\"'][^\"']*resident-radio[^\"']*[\"'][^>]*)/?>";
const LEDGER_ID_PATTERN =
  "<input\\b[^>]*\\bname=[\"']ID[\"'][^>]*\\bvalue=[\"']([0-9a-fA-F-]{36})[\"']";
const LEDGER_TYPE_PATTERN =
  "<input\\b[^>]*\\bname=[\"']Type[\"'][^>]*\\bvalue=[\"']([^\"']+)[\"']";
const BATCH_ID_PATTERN = "BankTransactions/Deposit/([0-9a-fA-F-]{36})";
const OE_TIP_PATTERN =
  "<div\\b[^>]*\\bclass=[\"'][^\"']*\\boe-tip\\b[^\"']*[\"'][^>]*>(.*?)</div>";
const INS_DETAIL_FOR_UUID = "\\bfor=\"([0-9a-fA-F-]{36})\"";
const INS_ITEM_ID_UUID = "\\bdata-item-id=\"([0-9a-fA-F-]{36})\"";
const INS_START_DATE_PATTERN =
  "<label\\b[^>]*for=\"StartDate\"[^>]*>.*?</label>\\s*<div[^>]*class=\"fv\"[^>]*>\\s*([\\d/]+)";
const INS_CANCEL_DATE_PATTERN =
  "<label\\b[^>]*for=\"CancelDate\"[^>]*>.*?</label>\\s*<div[^>]*class=\"fv\"[^>]*>\\s*([\\d/]+)";
const MODEL_STREET_PATTERN =
  "<div[^>]*\\bclass=[\"'][^\"']*model-street-address[^\"']*[\"'][^>]*>(.*?)</div>";
const CITY_STATE_ZIP_PATTERN = "^(.+),\\s*([A-Z]{2})\\s+(\\d{5}(?:-\\d{4})?)";
const FLOORPLAN_TEXT_PATTERN =
  "<a[^>]+href=[\"'][^\"']*UnitTypes/Detail/[0-9a-fA-F-]{36}[^\"']*[\"'][^>]*>(.*?)</a>";
const PHONE_PATTERN = "[\\+1]?[\\s.\\-\\(]*\\d[\\d\\s.\\-\\(\\)]{6,18}\\d";
const DATE_SCALAR_RE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const NUMBER_SCALAR_RE = /^-?[\d,]+(\.\d+)?$/;

// MARK: - LeaseHistoryRow

/** Port of the private `LeaseHistoryRow` struct. */
interface LeaseHistoryRow {
  residentName: string;
  leaseID: string;
  status: string;
  leaseStartDate: string | null;
  leaseEndDate: string | null;
  rent: number | null;
  moveOutDate: string | null;
}

/** A `#ResidentList` radio-button entry. Port of the Swift tuple. */
export interface ResidentEntry {
  /** `data-person-lease-id`: per-person-per-lease id, the `LeaseResident` key. */
  personLeaseId: string;
  /** `data-person-id`: per-person id, used as `?perid=` when fetching. */
  personId: string;
  /** `data-lease-id`: shared lease UUID used as the URL path. */
  leaseId: string;
  isPrimary: boolean;
}

// MARK: - scrapeUnit

/** Options for {@link scrapeUnit} (Swift `cachedFloorplans` / `knownPropertyId`). */
export interface ScrapeUnitOptions {
  cachedFloorplans?: BuildingFloorplans;
  knownPropertyId?: string;
  /**
   * Lease ids whose STORED status in the mirror is already terminal — i.e. we
   * have already captured their archived state. These are immutable, so they are
   * skipped on resync. A lease that only *now* shows a terminal status in the
   * history but is still stored non-terminal (a Current→terminal transition) is
   * deliberately NOT in this set, so it is synced one more time to record the
   * terminal state; on the following run it lands here and is skipped.
   */
  archivedLeaseIds?: ReadonlySet<string>;
}

/**
 * Terminal lease statuses — the resident has fully left or the application never
 * became a tenancy, so the lease is immutable and safe to skip once synced.
 * Everything else (Current, Pending, Pending Renewal, Notice to Vacate, Under
 * Eviction, Month to Month, and any unrecognized status) is treated as still
 * active and refreshed every run. Note `Under Eviction` is deliberately NOT
 * terminal (resident still in the unit) while `Evicted` is.
 */
const TERMINAL_LEASE_STATUS_SUBSTRINGS = ["former", "evicted", "cancel", "denied", "renewed"];
export function isTerminalLeaseStatus(status: string): boolean {
  const s = status.toLowerCase();
  return TERMINAL_LEASE_STATUS_SUBSTRINGS.some((term) => s.includes(term));
}

/**
 * A lease that is still an APPLICATION — the states the leasing Pipeline
 * shows. Used to decide which leases are worth the extra Activity Log request
 * that carries the approval date.
 *
 * "Pending Renewal" is excluded on purpose: a renewing resident never applied,
 * so there is no approval to find and the request would be wasted.
 */
const APPLICATION_LEASE_STATUS_PREFIXES = ["pending", "approved", "applicant", "prospect"];
export function isApplicationLeaseStatus(status: string): boolean {
  const s = status.trim().toLowerCase();
  if (s.includes("renewal")) return false;
  return APPLICATION_LEASE_STATUS_PREFIXES.some((prefix) => s.startsWith(prefix));
}

/**
 * Scrape a single unit's detail page + lease history into the unit dict.
 * Port of `ResManUnitDetailScraper.scrapeUnit`.
 *
 * Fetches `/Units/Detail/{unitId}` first, THEN the lease history sequentially
 * (never in parallel — see the file header). Current leases get a full
 * resident-page scrape (identity fields only, no tabs/ledger); past leases get a
 * skeleton from the history table row.
 */
export async function scrapeUnit(
  unitId: string,
  http: ResManScrapeHttp,
  opts: ScrapeUnitOptions = {},
): Promise<Record<string, unknown>> {
  const { cachedFloorplans, knownPropertyId, archivedLeaseIds } = opts;

  let unitHTML: string;
  let leaseHistoryHTML: string;
  let cachedTabEndpoints: Record<string, string> | undefined;

  if (knownPropertyId !== undefined) {
    const fallbackLeaseHistoryURL = `/Leases/UnitLeaseHistory?unitID=${unitId}&propertyID=${knownPropertyId}`;
    unitHTML = await http.getText(`/Units/Detail/${unitId}`);
    leaseHistoryHTML = await http.getText(fallbackLeaseHistoryURL);
  } else {
    unitHTML = await http.getText(`/Units/Detail/${unitId}`);
    const eps = dataURLEndpoints(unitHTML);
    cachedTabEndpoints = eps; // reuse below — skip second parse
    const pid = extractPropertyId(unitHTML, eps);
    if (pid === null) {
      throw ResManScrapingError.parsingFailed(
        `Could not find propertyID on unit page ${unitId}`,
      );
    }
    const ep = eps["Lease History"] ?? `/Leases/UnitLeaseHistory?unitID=${unitId}&propertyID=${pid}`;
    leaseHistoryHTML = await http.getText(ep);
  }

  const fields = flFvPairs(unitHTML);
  let propertyID: string;
  if (knownPropertyId !== undefined) {
    propertyID = knownPropertyId;
  } else {
    const tabEndpoints = cachedTabEndpoints ?? dataURLEndpoints(unitHTML);
    const extracted = extractPropertyId(unitHTML, tabEndpoints);
    if (extracted !== null) {
      propertyID = extracted;
    } else {
      throw ResManScrapingError.parsingFailed(
        `Could not find propertyID on unit page ${unitId}`,
      );
    }
  }

  const floorplanId = rmsFirstMatch(UNIT_TYPE_UUID, unitHTML);
  const floorplanText = firstFloorplanText(unitHTML);
  const buildingNameFloor = fields["Bld-Flr"] ?? "";
  const buildingParts = buildingNameFloor.split(" - ");
  const buildingName = trimmedForCell(buildingParts[0] ?? "");
  const floor = buildingParts.length > 1 ? trimmedForCell(buildingParts[1]) : null;

  const lookup = cachedFloorplans ?? (await fetchBuildingFloorplans(propertyID, http));
  const buildingLookup = lookup.buildings.find((b) => b.Name === buildingName);
  const floorplanLookup = lookup.floorplans.find(
    (f) =>
      f.floorplanId === floorplanId ||
      f.NameAndDescription === floorplanText ||
      f.Name === floorplanText,
  );

  const leaseRows = leaseHistoryRows(leaseHistoryHTML);

  const leases: Record<string, unknown>[] = [];
  let skippedArchived = 0;
  for (const leaseRow of leaseRows) {
    if (archivedLeaseIds?.has(leaseRow.leaseID)) {
      // Already stored in a terminal state — immutable, skip the re-sync.
      // (A lease that only now went terminal is NOT here yet, so it still falls
      // through and gets one more sync to record the terminal state.)
      skippedArchived += 1;
    } else if (containsCaseInsensitive(leaseRow.status, "current")) {
      // The active resident's lease — always re-scraped in full (may change).
      const lease = await scrapeLease(leaseRow, propertyID, unitId, true, http, false);
      leases.push(lease);
    } else if (isTerminalLeaseStatus(leaseRow.status)) {
      // A terminal lease we haven't captured (it's not in archivedLeaseIds):
      // this IS its one-time archival sync, so take everything — tabs and
      // ledger included. A skeleton here is how archived leases ended up
      // permanently empty: the skeleton's terminal status qualified it for
      // the skip before any real capture ever happened.
      const lease = await scrapeLease(leaseRow, propertyID, unitId, false, http, true);
      lease._deepCaptured = true;
      leases.push(lease);
    } else {
      // Non-current, still-active (Pending, Notice to Vacate, Under Eviction,
      // Month to Month, …) — refresh the skeleton from the history row; the
      // lease-details job owns their deep data while they can still change.
      const residentEntry: Record<string, unknown> = {
        personLeaseId: leaseRow.leaseID,
        fullName: leaseRow.residentName,
        isPrimary: true,
      };
      const skeleton: Record<string, unknown> = {
        leaseId: leaseRow.leaseID,
        status: leaseRow.status,
        residents: [residentEntry],
        // Marked so the job can strip the columns this dict has no source for.
        // Without that, the skeleton's blanks overwrite what the deep pass
        // read — see `withoutUnobservedFields`.
        _skeleton: true,
      };
      if (leaseRow.leaseStartDate !== null) skeleton.leaseStartDate = leaseRow.leaseStartDate;
      if (leaseRow.leaseEndDate !== null) skeleton.leaseEndDate = leaseRow.leaseEndDate;
      if (leaseRow.moveOutDate !== null) skeleton.moveOutDate = leaseRow.moveOutDate;
      if (leaseRow.rent !== null) skeleton.residentRent = leaseRow.rent;
      leases.push(skeleton);
    }
  }

  const propertyObj = compact({ id: propertyID, name: propertyName(leases) });
  const buildingObj = compact({ id: buildingLookup?.BuildingID, name: buildingName, floor });
  const floorplanName =
    floorplanLookup?.Name ??
    (floorplanText !== null ? trimmedForCell(floorplanText.split(" - ")[0] ?? "") : null);
  const floorplanObj = compact({
    id: floorplanId ?? floorplanLookup?.floorplanId,
    name: floorplanName,
    description: floorplanLookup?.Description,
    allowsMultipleLeases: floorplanLookup?.AllowsMultipleLeases,
    squareFootage: floorplanLookup?.SquareFootage,
    totalUnits: floorplanLookup?.TotalUnits,
  });
  const vacancyDays = daysVacant(fields["Days vacant/Lifetime"]);

  const output: Record<string, unknown> = {
    sourceUrl: `${http.base}#/Units/Detail/${unitId}`,
    unitId,
    property: propertyObj,
    unitNumber: fields["Number"] ?? null,
    building: buildingObj,
    floorplan: floorplanObj,
    status: fields["Status"] ?? null,
    occupied: yesNo(fields["Occupied"]),
    squareFootage: intOrNull(fields["Sq Ft"]),
    marketRent: moneyCategory(fields["Market rent"]),
    deposit: moneyCategory(fields["Deposit"]),
    address: parseUnitAddress(unitHTML),
    daysVacant: vacancyDays.current,
    lifetimeDaysVacant: vacancyDays.lifetime,
    petsPermitted: petsPermittedBool(fields["Pets permitted"]),
    availableForOnlineMarketing: yesNo(fields["Available for online marketing"]),
    affordableUnit: yesNo(fields["Affordable unit"]),
    holdingUnit: yesNo(fields["Holding unit"]),
    leases,
  };
  // Internal counter for the job's progress log (ignored by the mappers).
  if (skippedArchived > 0) output._skippedArchivedLeases = skippedArchived;

  return output;
}

/**
 * Resolve a property UUID from the unit page: the `propertyID=` query form, then
 * the JSON `PropertyID:` form, then the first tab endpoint carrying a
 * `propertyID=`. Mirrors the chained `??` in `scrapeUnit`.
 */
function extractPropertyId(
  unitHTML: string,
  endpoints: Record<string, string>,
): string | null {
  const fromQuery = rmsFirstMatch(PROP_ID_QUERY, unitHTML);
  if (fromQuery !== null) return fromQuery;
  const fromJson = rmsFirstMatch(PROP_ID_JSON, unitHTML);
  if (fromJson !== null) return fromJson;
  for (const value of Object.values(endpoints)) {
    const fromEndpoint = rmsFirstMatch(PROP_ID_QUERY, value);
    if (fromEndpoint !== null) return fromEndpoint;
  }
  return null;
}

// MARK: - scrapeLease

/**
 * Scrape a lease's fields, residents (with optional tabs), and optional ledger
 * into the lease dict. Port of the primary
 * `scrapeLease(leaseRow:propertyID:unitID:isCurrent:http:fetchTabsAndLedger:)`.
 *
 * `leaseRow.leaseID` is the primary resident's personLeaseId — the lease history
 * link points to that person's `/Residents/Detail/{id}` page.
 */
export async function scrapeLease(
  leaseRow: LeaseHistoryRow,
  propertyId: string,
  unitId: string,
  isCurrent: boolean,
  http: ResManScrapeHttp,
  fetchTabsAndLedger = true,
): Promise<Record<string, unknown>> {
  void propertyId;
  void unitId;
  void isCurrent;

  const primaryHTML = await http.getText(`/Residents/Detail/${leaseRow.leaseID}`);
  const hidden = hiddenInputs(primaryHTML);
  const fields = flFvPairs(primaryHTML);

  const leaseID = hidden["LeaseID"] ?? hidden["lID"] ?? leaseRow.leaseID;
  // UnitLeaseGroupID is not in hidden inputs on all pages — ResMan also encodes
  // it in button data-dialog-content-url attributes.
  const unitLeaseGroupID =
    hidden["UnitLeaseGroupID"] ??
    hidden["ulgID"] ??
    rmsFirstMatch(UNIT_LEASE_GROUP_UUID, primaryHTML) ??
    undefined;
  const rentValue = leaseRow.rent ?? numOrNull(fields["Resident Rent"]);
  const moveOutValue = normalizeDate(fields["Move-out date"]) ?? leaseRow.moveOutDate;

  const lease: Record<string, unknown> = {
    leaseId: leaseID,
    status: hidden["ResidencyStatus"] ?? hidden["PersonLevelLeaseStatus"] ?? leaseRow.status,
    leaseStartDate: leaseRow.leaseStartDate ?? null,
    leaseEndDate: leaseRow.leaseEndDate ?? null,
    residentRent: rentValue ?? null,
    moveOutDate: moveOutValue ?? null,
  };

  if (unitLeaseGroupID !== undefined) lease.unitLeaseGroupId = unitLeaseGroupID;
  if (fields["Property"] !== undefined) lease.propertyName = fields["Property"];
  if (fields["Leasing agent"] !== undefined) lease.leasingAgent = fields["Leasing agent"];
  if (fields["Approval status"] !== undefined) lease.approvalStatus = fields["Approval status"];
  assignIfPresent(lease, "marketRent", numOrNull(fields["Market rent"]));
  assignIfPresent(
    lease,
    "leaseSignedDate",
    normalizeDate(fields["Lease signed date"] ?? labelForValue("LeaseSignedDate", primaryHTML)),
  );
  assignIfPresent(
    lease,
    "applicationDate",
    normalizeDate(fields["Application date"] ?? labelForValue("ApplicationDate", primaryHTML)),
  );
  assignIfPresent(
    lease,
    "moveInDate",
    normalizeDate(fields["Move-in date"] ?? labelForValue("MoveInDate", primaryHTML)),
  );
  // The approval DATE, from the Activity Log — one extra request, and only
  // for a lease that could still be an application. A settled residency's
  // approval is history the Pipeline never shows, and spending a request per
  // lease on all ~640 full-tier leases to fetch it would be most of a sync.
  if (isApplicationLeaseStatus(String(lease.status ?? ""))) {
    const log = await scrapeActivityLog(leaseRow.leaseID, http);
    assignIfPresent(lease, "approvedDate", log.approvedDate);
    if (log.approvedBy.length > 0) lease.approvedBy = log.approvedBy;
    assignIfPresent(lease, "originalStartDate", log.originalStartDate);
    if (log.startDateChanges > 0) lease.startDateChanges = log.startDateChanges;
    assignIfPresent(lease, "leaseSentDate", log.leaseSentDate);
    assignIfPresent(lease, "leaseVoidedDate", log.leaseVoidedDate);
    // The PAGE wins where it has a value; the log only fills a blank. Both
    // application date and signed date are absent from the page on most
    // applications (2 of 45 carry an application date), and the log is the
    // only record of them — but where ResMan states a date, it is the source
    // of truth and must not be second-guessed by a log line.
    if (lease.applicationDate === undefined) {
      assignIfPresent(lease, "applicationDate", log.onlineApplicationDate);
    }
    if (lease.leaseSignedDate === undefined) {
      assignIfPresent(lease, "leaseSignedDate", log.leaseSignedDate);
    }
  }

  // `renewalDate` is NOT read: there is no `for="RenewalDate"` node on the
  // page, checked against a Pending Renewal lease. ResMan does not surface it
  // here, so the column stays null rather than pretending.
  //
  // The NTV date needs the labelForValue route, like the three dates above.
  // Its fl/fv label is not standalone — the Vacating Information block puts
  // several labels in one `fl` div, so flFvPairs returns the whole run as a
  // single mangled key ("Application date 9/9/2025 Lease signed date … NTV
  // date") and `fields["NTV date"]` is never present. That is why
  // notice_given_date was null on all 1,252 leases. Verified on 1732 ST-4
  // (Notice to Vacate): `for="NoticeGivenDate"` holds "7/31/2026".
  assignIfPresent(
    lease,
    "noticeGivenDate",
    normalizeDate(fields["NTV date"] ?? labelForValue("NoticeGivenDate", primaryHTML)),
  );
  // Left on the fl/fv route deliberately: hap_rent is populated on ~2.7% of
  // leases, so this read demonstrably works and the column is simply sparse —
  // only HAP residents have one.
  assignIfPresent(lease, "hapRent", numOrNull(fields["HAP Rent"]));
  // NO balance / collection read here, deliberately.
  //
  // The resident page has the boxes — `<div class="fl">Balance</div><div
  // id="Balance" class="fv"></div>`, and the same for Deposits and Collection —
  // but the server sends them EMPTY. ResMan fills that whole BalancesTable with
  // JavaScript, and adds the `red` class at the same time, so a browser's
  // Inspect panel shows a number that View Source does not. Verified against
  // 1833 WX-4, which owes $8,165.75: the raw response contains neither the
  // figure nor the `fv red` class, and `flFvPairs` returns undefined for the
  // label (it skips pairs whose value is empty).
  //
  // Reading them here therefore could not work — and did not, for all 1,252
  // leases in the mirror. It only looked like it might, which is worse than an
  // obvious gap: `balance` was silently null everywhere and the delinquency
  // view papered over it with a unit-level fallback for current leases.
  //
  // The balance is set from the LEDGER instead — see leaseBalanceFromLedger in
  // ./leases, which is exact (matched resman_units.balance to the cent on the
  // four largest debtors) and free, because the ledger is already fetched.
  // `collection_balance` has no such source and stays null; recovering it would
  // mean executing ResMan's JavaScript, a headless browser per lease.
  const reason = fields["Reason for leaving"];
  if (reason !== undefined) {
    const v = trimmedForCell(reason);
    if (v.length > 0) lease.reasonForLeaving = v;
  }

  const residentEntries = residentListEntries(primaryHTML);
  if (fetchTabsAndLedger) {
    // Ledger and residents-with-tabs are independent — run them together.
    const leaseTabs = dataURLEndpoints(primaryHTML);
    const [ledgerRows, residents] = await Promise.all([
      fetchAllLedger("Ledger", leaseTabs, http),
      scrapeAllResidents({
        entries: residentEntries,
        primaryPersonLeaseId: leaseRow.leaseID,
        primaryHTML,
        primaryHidden: hidden,
        primaryFields: fields,
        leaseRow,
        http,
        fetchTabs: true,
      }),
    ]);
    if (ledgerRows.length > 0) lease.ledger = ledgerRows;
    if (residents.length > 0) lease.residents = residents;
  } else {
    // Identity-only path: skip ledger and resident tab fetches.
    const residents = await scrapeAllResidents({
      entries: residentEntries,
      primaryPersonLeaseId: leaseRow.leaseID,
      primaryHTML,
      primaryHidden: hidden,
      primaryFields: fields,
      leaseRow,
      http,
      fetchTabs: false,
    });
    if (residents.length > 0) lease.residents = residents;
  }

  return lease;
}

/**
 * Convenience overload for fetching a lease when only the personLeaseId (URL
 * path UUID) is known — used by the deep-sync path to fill in historical lease
 * skeletons. Port of
 * `scrapeLease(personLeaseId:propertyID:unitID:http:fetchTabsAndLedger:)`.
 */
export async function scrapeLeaseByPersonLeaseId(
  personLeaseId: string,
  propertyId: string,
  unitId: string,
  http: ResManScrapeHttp,
  fetchTabsAndLedger = true,
): Promise<Record<string, unknown>> {
  const syntheticRow: LeaseHistoryRow = {
    residentName: "",
    leaseID: personLeaseId,
    status: "",
    leaseStartDate: null,
    leaseEndDate: null,
    rent: null,
    moveOutDate: null,
  };
  return scrapeLease(syntheticRow, propertyId, unitId, false, http, fetchTabsAndLedger);
}

// MARK: - scrapeLeaseLedgerOnly

/**
 * The LEDGER of an already-captured lease, and nothing else.
 *
 * Once a lease has been deep-captured, its fields and its residents' tabs
 * (vehicles, employment, insurance, addresses, contacts) do not change — but
 * its ledger keeps moving for as long as a balance exists: charges post,
 * payments land, write-offs and collections activity continue long after a
 * resident has left. Re-running the full scrape to pick that up costs roughly
 * 13 requests on a two-resident lease (the detail page, then a page and five
 * tabs per resident); this costs TWO — the detail page purely to locate the
 * Ledger tab endpoint, then the ledger itself with LoadAllTransactions.
 *
 * Against a portal that serves error pages above six concurrent connections,
 * that difference is what makes refreshing every settled lease affordable.
 */
export async function scrapeLeaseLedgerOnly(
  personLeaseId: string,
  http: ResManScrapeHttp,
): Promise<Record<string, unknown>[]> {
  const html = await http.getText(`/Residents/Detail/${personLeaseId}`);
  return fetchAllLedger("Ledger", dataURLEndpoints(html), http);
}

// MARK: - scrapeResidentStatusAndTabs

/**
 * Fetch a resident detail page and return the live residency status plus tab
 * data. Port of `scrapeResidentStatusAndTabs`. When `fetchTabsAndLedger` is
 * false, only resident identity fields are returned (no ledger / no tabs).
 */
export async function scrapeResidentStatusAndTabs(
  leaseId: string,
  http: ResManScrapeHttp,
  fetchTabsAndLedger = true,
): Promise<{ status: string; tabData: Record<string, unknown> }> {
  const html = await http.getText(`/Residents/Detail/${leaseId}`);
  const hidden = hiddenInputs(html);
  const status = hidden["ResidencyStatus"] ?? hidden["PersonLevelLeaseStatus"] ?? "";
  const entries = residentListEntries(html);
  const fields = flFvPairs(html);

  const tabData: Record<string, unknown> = {};

  if (fetchTabsAndLedger) {
    const tabs = dataURLEndpoints(html);
    const [ledgerRows, residents] = await Promise.all([
      fetchAllLedger("Ledger", tabs, http),
      scrapeAllResidents({
        entries,
        primaryPersonLeaseId: leaseId,
        primaryHTML: html,
        primaryHidden: hidden,
        primaryFields: fields,
        leaseRow: null,
        http,
        fetchTabs: true,
      }),
    ]);
    if (ledgerRows.length > 0) tabData.ledger = ledgerRows;
    if (residents.length > 0) tabData.residents = residents;
  } else {
    const residents = await scrapeAllResidents({
      entries,
      primaryPersonLeaseId: leaseId,
      primaryHTML: html,
      primaryHidden: hidden,
      primaryFields: fields,
      leaseRow: null,
      http,
      fetchTabs: false,
    });
    if (residents.length > 0) tabData.residents = residents;
  }

  return { status, tabData };
}

// MARK: - Multi-resident helpers

/**
 * Extract all `#ResidentList` resident-radio entries. Port of
 * `residentListEntries(in:)`.
 */
export function residentListEntries(html: string): ResidentEntry[] {
  const out: ResidentEntry[] = [];
  for (const match of rmsMatches(RESIDENT_RADIO_PATTERN, html)) {
    if (match.length <= 1) continue;
    const attrs = match[1];
    const plid = attr("data-person-lease-id", attrs);
    const pid = attr("data-person-id", attrs);
    if (plid === null || pid === null) continue;
    const leaseId = attr("data-lease-id", attrs) ?? "";
    const isPrimary = match[0].includes("checked");
    out.push({ personLeaseId: plid, personId: pid, leaseId, isPrimary });
  }
  return out;
}

/** Parameters for {@link scrapeAllResidents}. */
export interface ScrapeAllResidentsParams {
  entries: ResidentEntry[];
  primaryPersonLeaseId: string;
  primaryHTML: string;
  primaryHidden: Record<string, string>;
  primaryFields: Record<string, string>;
  leaseRow: LeaseHistoryRow | null;
  http: ResManScrapeHttp;
  fetchTabs?: boolean;
}

/**
 * Scrape every resident in `entries`, reusing the already-fetched primary page
 * HTML and fetching additional resident pages with bounded concurrency. Results
 * are ordered primary-first then by `fullName` for determinism. Port of
 * `scrapeAllResidents`.
 */
export async function scrapeAllResidents(
  params: ScrapeAllResidentsParams,
): Promise<Record<string, unknown>[]> {
  const {
    entries,
    primaryPersonLeaseId,
    primaryHTML,
    primaryHidden,
    primaryFields,
    leaseRow,
    http,
  } = params;
  const fetchTabs = params.fetchTabs ?? true;

  // If ResidentList is absent (older ResMan pages), synthesise a single entry.
  const resolved: ResidentEntry[] =
    entries.length === 0
      ? [
          {
            personLeaseId: primaryPersonLeaseId,
            personId: primaryHidden["PersonID"] ?? primaryHidden["perID"] ?? "",
            leaseId: "",
            isPrimary: true,
          },
        ]
      : entries;

  const dicts = await mapWithConcurrency(resolved, RESIDENT_CONCURRENCY, async (entry) => {
    let html: string;
    let hidden: Record<string, string>;
    let fields: Record<string, string>;
    if (entry.isPrimary) {
      html = primaryHTML;
      hidden = primaryHidden;
      fields = primaryFields;
    } else {
      // Use data-lease-id (shared per lease) as the URL path, then ?perid= to
      // tell ResMan which person's Personal Information panel to render.
      const pathId = entry.leaseId.length === 0 ? entry.personLeaseId : entry.leaseId;
      const perid = entry.personId.length === 0 ? "" : `?perid=${entry.personId}`;
      html = await http.getText(`/Residents/Detail/${pathId}${perid}`);
      hidden = hiddenInputs(html);
      fields = flFvPairs(html);
    }
    return scrapeResidentDictWithTabs({
      personLeaseId: entry.personLeaseId,
      personId: entry.personId,
      isPrimary: entry.isPrimary,
      html,
      hidden,
      fields,
      leaseRow: entry.isPrimary ? leaseRow : null,
      http,
      fetchTabs,
    });
  });

  // Primary first, then alphabetical by fullName (absent → "", so stable).
  return dicts.sort((a, b) => {
    const ap = typeof a.isPrimary === "boolean" ? a.isPrimary : false;
    const bp = typeof b.isPrimary === "boolean" ? b.isPrimary : false;
    if (ap !== bp) return ap ? -1 : 1;
    const an = typeof a.fullName === "string" ? a.fullName : "";
    const bn = typeof b.fullName === "string" ? b.fullName : "";
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  });
}

/** Parameters for {@link scrapeResidentDictWithTabs}. */
export interface ScrapeResidentDictParams {
  personLeaseId: string;
  personId: string;
  isPrimary: boolean;
  html: string;
  hidden: Record<string, string>;
  fields: Record<string, string>;
  leaseRow: LeaseHistoryRow | null;
  http: ResManScrapeHttp;
  fetchTabs?: boolean;
}

/**
 * Build the resident identity dict AND optionally fetch its 6 tab types with
 * bounded concurrency. Port of `scrapeResidentDictWithTabs`.
 */
export async function scrapeResidentDictWithTabs(
  params: ScrapeResidentDictParams,
): Promise<Record<string, unknown>> {
  const { personLeaseId, personId, isPrimary, html, hidden, fields, leaseRow, http } = params;
  const fetchTabs = params.fetchTabs ?? true;

  const r = buildResidentDict({
    personLeaseId,
    personId,
    isPrimary,
    html,
    hidden,
    fields,
    leaseRow,
  });
  if (!fetchTabs) return r;

  const tabs = dataURLEndpoints(html);
  // Order matters for destructuring; mapWithConcurrency preserves input order.
  // "Employment & Other Income" is ONE combined ResMan tab, so it is fetched
  // once (fetching "Employment" and "Other Income" separately hit the same URL
  // and doubled every row). Each tab uses a bespoke parser matching its real
  // HTML (see the "Resident lease tabs" section).
  const [vehRows, empRows, insRows, addrRows, altConRows] = await mapWithConcurrency(
    [
      () => scrapeVehiclesTab("Vehicles", tabs, http),
      () => scrapeEmploymentTab("Employment", tabs, http),
      () => scrapeInsuranceTab("Insurance", tabs, http),
      () => scrapeAddressesTab("Addresses", tabs, http),
      () => scrapeAlternateContactsTab("Alternate Contact", tabs, http),
    ],
    TAB_CONCURRENCY,
    (thunk) => thunk(),
  );

  if (vehRows.length > 0) r.vehicles = vehRows;
  if (empRows.length > 0) r.employment = empRows;
  if (insRows.length > 0) r.insurance = insRows;
  if (addrRows.length > 0) r.addresses = addrRows;
  if (altConRows.length > 0) r.alternateContacts = altConRows;
  return r;
}

/** Parameters for {@link buildResidentDict}. */
export interface BuildResidentDictParams {
  personLeaseId: string;
  personId: string;
  isPrimary: boolean;
  html: string;
  hidden: Record<string, string>;
  fields: Record<string, string>;
  leaseRow: LeaseHistoryRow | null;
}

/**
 * Build the core resident identity dict from a loaded detail page. Port of
 * `buildResidentDict`. (`html` and `leaseRow` are accepted to mirror the Swift
 * signature but are not read by the identity build.)
 */
export function buildResidentDict(
  params: BuildResidentDictParams,
): Record<string, unknown> {
  const { personLeaseId, personId, isPrimary, hidden, fields } = params;

  const resolvedPersonId =
    personId.length === 0 ? (hidden["PersonID"] ?? hidden["perID"] ?? "") : personId;
  const firstName = titleCaseName(hidden["FirstName"]) ?? "";
  const lastName = titleCaseName(hidden["LastName"]) ?? "";
  const phones = fields["Phone numbers"] !== undefined ? extractPhones(fields["Phone numbers"]) : [];

  const r = compact({
    personLeaseId,
    personId: nilIfBlank(resolvedPersonId),
    firstName: nilIfBlank(firstName),
    lastName: nilIfBlank(lastName),
    gender: fields["Gender"],
    birthdate: normalizeDate(fields["Birthdate"]),
    email: fields["Email"],
    language: fields["Language"],
    identification: fields["Identification"] ?? firstIdentification(fields),
    driversLicense: driversLicenseNumber(fields["Drivers lic."]),
    driversLicenseState: driversLicenseState(fields["Drivers lic."]),
    householdStatus: fields["Household status"],
  });
  r.isPrimary = isPrimary;
  if (phones.length > 0) r.phoneNumbers = phones;
  return r;
}

// MARK: - fetchBuildingFloorplans

/**
 * Fetch and decode `/Units/GetBuildingsAndUnitTypes?propertyId={id}`. Port of
 * `fetchBuildingFloorplans(propertyID:http:)` — throws `parsingFailed` on any
 * structural decode error, matching the Swift `do/catch`.
 */
export async function fetchBuildingFloorplans(
  propertyId: string,
  http: ResManScrapeHttp,
): Promise<BuildingFloorplans> {
  const endpoint = `/Units/GetBuildingsAndUnitTypes?propertyId=${propertyId}`;
  const json = await http.getJson(endpoint);
  return decodeBuildingFloorplans(json, endpoint);
}

// MARK: - Lease history table

/** Port of `leaseHistoryRows(from:)`. */
function leaseHistoryRows(html: string): LeaseHistoryRow[] {
  const rows: LeaseHistoryRow[] = [];
  for (const rowMatch of rmsMatches(TR_PATTERN, html)) {
    if (rowMatch.length <= 1) continue;
    const rowHTML = rowMatch[1];
    const cells = rmsMatches(TD_TH_PATTERN, rowHTML)
      .filter((m) => m.length > 1)
      .map((m) => stripTags(m[1]));
    if (cells.length < 3) continue;
    if (containsCaseInsensitive(cells[0], "Residents")) continue;
    const leaseID = rmsFirstMatch(RESIDENT_DETAIL_UUID, rowHTML);
    if (leaseID === null) continue;
    const dates = cells.length > 2 ? parseDateRange(cells[2]) : { start: null, end: null };
    rows.push({
      residentName: cells[0],
      leaseID,
      status: cells.length > 1 ? cells[1] : "",
      leaseStartDate: dates.start,
      leaseEndDate: dates.end,
      rent: null,
      moveOutDate: cells.length > 3 ? normalizeDate(cells[3]) : null,
    });
  }
  return rows;
}

// MARK: - Ledger

/**
 * Fetch the ledger tab (appending `LoadAllTransactions=true`) and parse it. Port
 * of `fetchAllLedger(named:in:http:)`.
 */
async function fetchAllLedger(
  name: string,
  tabs: Record<string, string>,
  http: ResManScrapeHttp,
): Promise<Record<string, unknown>[]> {
  const ep = endpointNamed(name, tabs);
  if (ep === null) return [];
  const fullEP = ep + (ep.includes("?") ? "&" : "?") + "LoadAllTransactions=true";
  const html = await http.getText(fullEP);
  return scrapeLedger(html);
}

/**
 * Parse ResMan's split-table ledger HTML into transaction dicts. The real
 * transaction UUID and type live in hidden inputs, not visible cells. Port of
 * `scrapeLedger(from:)`.
 */
function scrapeLedger(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const rowMatch of rmsMatches(TR_PATTERN, html)) {
    if (rowMatch.length <= 1) continue;
    const rowHTML = rowMatch[1];

    // Skip rows without a real transaction UUID (e.g. "Balance as of …").
    const txID = rmsFirstMatch(LEDGER_ID_PATTERN, rowHTML);
    if (txID === null || txID.length === 0) continue;

    const txType = rmsFirstMatch(LEDGER_TYPE_PATTERN, rowHTML) ?? "";
    const amounts = allTdContent("l-amount-col", rowHTML);

    const row: Record<string, unknown> = { transactionId: txID, transactionType: txType };
    assignIfPresent(row, "date", tdContent("l-date-col", rowHTML));
    assignIfPresent(row, "reference", tdContent("l-reference-col", rowHTML));
    assignIfPresent(row, "category", tdContent("l-category-col", rowHTML));
    assignIfPresent(row, "description", tdContent("l-description-col", rowHTML));
    assignIfPresent(row, "notes", tdContent("l-notes-col", rowHTML));
    // Batch column: display number is the anchor text; UUID is in the href.
    assignIfPresent(row, "batch", tdContent("l-batch-col", rowHTML));
    assignIfPresent(row, "batchId", rmsFirstMatch(BATCH_ID_PATTERN, rowHTML));
    // Position 0 = Charges, position 1 = Credits (null = empty cell).
    if (amounts.length > 0) assignIfPresent(row, "charges", numOrNull(amounts[0]));
    if (amounts.length > 1) assignIfPresent(row, "credits", numOrNull(amounts[1]));
    const balanceText = tdContent("l-balance-col", rowHTML);
    if (balanceText !== null) assignIfPresent(row, "balance", numOrNull(balanceText));

    out.push(row);
  }
  return out;
}

/**
 * Trimmed text of the first `<td>` whose class contains `className`, preferring a
 * nested `.oe-tip` div. Port of `tdContent(_:in:)`.
 */
function tdContent(className: string, html: string): string | null {
  const matches = rmsMatches(tdClassPattern(className), html);
  const m = matches.length > 0 ? matches[0] : undefined;
  if (m === undefined || m.length <= 1) return null;
  const inner = m[1];
  const tip = rmsFirstMatch(OE_TIP_PATTERN, inner);
  const text = tip !== null ? tip : trimmedForCell(stripTags(inner).replace(/\s+/g, " "));
  return nilIfBlank(text) ?? null;
}

/**
 * Trimmed text of ALL `<td>`s with the given class, keeping `null` for empty
 * cells so positional mapping (Charges=0, Credits=1) is preserved. Port of
 * `allTdContent(_:in:)`.
 */
function allTdContent(className: string, html: string): (string | null)[] {
  return rmsMatches(tdClassPattern(className), html).map((m) => {
    if (m.length <= 1) return null;
    const text = trimmedForCell(stripTags(m[1]).replace(/\s+/g, " "));
    return nilIfBlank(text) ?? null;
  });
}

/** `<td class="… className …">(...)</td>` pattern for a given cell class. */
function tdClassPattern(className: string): string {
  return `<td\\b[^>]*\\bclass=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>(.*?)</td>`;
}

// MARK: - Insurance tab (two-row-per-record structure)

/** Fetch + parse the Insurance tab. Port of `scrapeInsuranceTab`. */
async function scrapeInsuranceTab(
  name: string,
  tabs: Record<string, string>,
  http: ResManScrapeHttp,
): Promise<Record<string, unknown>[]> {
  const ep = endpointNamed(name, tabs);
  if (ep === null) return [];
  const html = await http.getText(ep);
  return parseInsuranceRows(html);
}

/**
 * Parse the Insurance tab HTML. Each record spans a main row (`data-item-id`)
 * plus a hidden detail row (`for=` + `detail-row`) carrying start/cancel dates in
 * a nested table. Port of `parseInsuranceRows(from:)`.
 */
function parseInsuranceRows(html: string): Record<string, unknown>[] {
  const allRows = rmsMatches(TR_PATTERN, html);
  if (allRows.length <= 1) return [];

  const headerCells = rmsMatches(TD_TH_PATTERN, allRows[0][1])
    .filter((m) => m.length > 1)
    .map((m) => stripTags(m[1]))
    .filter((s) => s.length > 0);
  if (headerCells.length === 0) return [];

  const mainRows: Record<string, unknown>[] = [];
  const detailExtras: Record<string, Record<string, string>> = {};

  for (const rowMatch of allRows.slice(1)) {
    if (rowMatch.length <= 1) continue;
    const fullTag = rowMatch[0];
    const rowHTML = rowMatch[1];

    if (fullTag.includes("detail-row")) {
      const uuid = rmsFirstMatch(INS_DETAIL_FOR_UUID, fullTag);
      if (uuid === null) continue;
      const extras: Record<string, string> = {};
      const start = rmsFirstMatch(INS_START_DATE_PATTERN, rowHTML);
      if (start !== null) extras["Start Date"] = start;
      const cancel = rmsFirstMatch(INS_CANCEL_DATE_PATTERN, rowHTML);
      if (cancel !== null) extras["Cancel Date"] = cancel;
      if (Object.keys(extras).length > 0) detailExtras[uuid] = extras;
      continue;
    }

    // Only accept main data rows — these carry data-item-id.
    if (!fullTag.includes("data-item-id")) continue;

    const cells = rmsMatches(TD_TH_PATTERN, rowHTML)
      .filter((m) => m.length > 1)
      .map((m) => stripTags(m[1]));
    if (cells.length === 0) continue;

    const row: Record<string, unknown> = {};
    headerCells.forEach((heading, i) => {
      if (i < cells.length) {
        const v = normalizeScalar(cells[i]);
        if (v !== null) row[heading] = v;
      }
    });

    const uuid = rmsFirstMatch(INS_ITEM_ID_UUID, fullTag);
    if (uuid !== null) row._ins_id = uuid;

    if (Object.keys(row).length > 0) mainRows.push(row);
  }

  // Merge detail extras into each main row, then drop the temp key.
  return mainRows.map((row) => {
    const merged: Record<string, unknown> = { ...row };
    const insId = typeof row._ins_id === "string" ? row._ins_id : undefined;
    if (insId !== undefined && detailExtras[insId] !== undefined) {
      for (const [k, v] of Object.entries(detailExtras[insId])) merged[k] = v;
    }
    delete merged._ins_id;
    return merged;
  });
}

// MARK: - Resident lease tabs (bespoke parsers per ResMan's real HTML)
//
// These five tabs do NOT share the generic header-row/data-row shape that
// `rowDictionaries` assumes. From captured live HTML:
//   - Vehicles (#AutomobilesTable): NO header row; each vehicle is a `fl`/`fv`
//     card spread across per-column `<td class="a-*-col">` cells, with make and
//     model combined ("Honda Civic") and plate+state combined ("BSD5075 / TN"),
//     plus a following notes row and a buttons row.
//   - Employment & Other Income (#Employments): ONE combined tab (the anchor is
//     "Employment & Other Income"); a positional main row + a hidden
//     `detail-row` whose NESTED `<table>` holds start date / phone as `fl`/`fv`.
//   - Addresses (#Addresses): real header row, but a single combined
//     "City/State/Zip" column that must be split, and no date columns.
//   - Alternate Contacts: real header row, but the "Emergency" cell is a
//     checkmark icon (no text) and each record is trailed by a nested detail
//     row.
//   - Insurance: handled by the bespoke `parseInsuranceRows` above.
// Each parser emits dict keys the residents.ts mappers already `pick()`, so the
// mapper layer is unchanged. Row ids stay positional (assigned by the mapper).

/** Inner HTML of the first `<td>` whose class list contains `colClass`, or "". */
function tabCellInner(colClass: string, html: string): string {
  const inner = rmsFirstMatch(
    `<td\\b[^>]*\\bclass=["'][^"']*\\b${colClass}\\b[^"']*["'][^>]*>(.*?)</td>`,
    html,
  );
  return inner ?? "";
}

/**
 * Text of the `<div class="fv">` value inside a cell (ResMan wraps values in
 * `fl`/`fv` pairs, often with a nested `.oe-tip`). Falls back to the whole cell.
 */
function fvText(cellInner: string): string {
  if (cellInner.length === 0) return "";
  const fv = rmsFirstMatch(
    `<div\\b[^>]*\\bclass=["'][^"']*\\bfv\\b[^"']*["'][^>]*>(.*?)</div>`,
    cellInner,
  );
  return stripTags(fv ?? cellInner);
}

/** Fetch + parse the Vehicles tab. */
async function scrapeVehiclesTab(
  name: string,
  tabs: Record<string, string>,
  http: ResManScrapeHttp,
): Promise<Record<string, unknown>[]> {
  const ep = endpointNamed(name, tabs);
  if (ep === null) return [];
  return parseVehiclesTab(await http.getText(ep));
}

/**
 * Parse the Vehicles tab. Each vehicle spans a main `<tr>` (the `a-*-col`
 * cards) and a following notes `<tr>` (`a-notes-col`); a buttons `<tr>` is
 * ignored. Make/model and plate/state arrive combined and are split here.
 */
/** Values that mean "nothing recorded" once the slash split is undone. */
const NOT_RECORDED = new Set(["", "N/A", "NA", "NONE", "UNKNOWN", "-", "--"]);

/**
 * ResMan packs plate and state into one cell as "PLATE/ST". Splitting on the
 * slash is right until someone types "N/A", which yields plate "N" and state
 * "A" — a plate that reads as real and matches nothing. Recognise the
 * placeholder before splitting, and only treat the tail as a state when it
 * actually looks like one.
 */
export function splitLicensePlate(raw: string): { plate: string; state: string } {
  const value = raw.trim();
  if (NOT_RECORDED.has(value.toUpperCase())) return { plate: "", state: "" };

  const slash = value.indexOf("/");
  if (slash === -1) return { plate: value, state: "" };

  const plate = value.slice(0, slash).trim();
  const state = value.slice(slash + 1).trim();

  // "N/A" survives the set check in odd spellings ("n / a"); a one-letter plate
  // beside a one-letter "state" is that, not a vehicle.
  if (plate.length <= 1 && state.length <= 1) return { plate: "", state: "" };
  // A state is two letters. Anything else belongs to the plate.
  if (!/^[A-Za-z]{2}$/.test(state)) return { plate: value, state: "" };

  return { plate, state };
}

export function parseVehiclesTab(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const rowMatch of rmsMatches(TR_PATTERN, html)) {
    if (rowMatch.length <= 1) continue;
    const rowHTML = rowMatch[1];

    if (/\ba-make-model-col\b/i.test(rowHTML)) {
      const makeModel = fvText(tabCellInner("a-make-model-col", rowHTML));
      const [make, ...modelParts] = makeModel.split(/\s+/).filter((s) => s.length > 0);
      const { plate, state } = splitLicensePlate(fvText(tabCellInner("a-license-plate-col", rowHTML)));
      const row: Record<string, unknown> = {};
      assignText(row, "Year", fvText(tabCellInner("a-year-col", rowHTML)));
      // The register is typed by hand, so the same marque arrives as "HONDA",
      // "honda" and "Honda". Case is normalized here rather than at each reader.
      assignText(row, "Make", titleCaseName(make ?? "") ?? "");
      assignText(row, "Model", titleCaseName(modelParts.join(" ")) ?? "");
      assignText(row, "Color", titleCaseName(fvText(tabCellInner("a-color-col", rowHTML))) ?? "");
      // Plates stay verbatim but upper — they're identifiers, not prose.
      assignText(row, "License Plate", plate.toUpperCase());
      assignText(row, "State", state.toUpperCase());
      // The parking DECAL number ("Permit number" on the tab). There is no
      // parking-space field anywhere on this tab — `parking_spot` was mapped
      // from keys ResMan never sends and stayed empty on all 721 vehicles.
      assignText(row, "Permit Number", fvText(tabCellInner("a-permit-col", rowHTML)));
      out.push(row);
      continue;
    }

    if (/\ba-notes-col\b/i.test(rowHTML) && out.length > 0) {
      assignText(out[out.length - 1], "Notes", fvText(tabCellInner("a-notes-col", rowHTML)));
    }
  }
  return out;
}

/**
 * The Activity Log line recording that an application was approved, or null
 * when the log holds none.
 *
 * ResMan has no approval-date FIELD anywhere — the resident page carries
 * "Approval status" (a bare "Approved"/"Denied") with no date beside it, and
 * the Applications and Screening Results tabs come back empty on this
 * property. The Activity Log is the only place the moment is recorded:
 *
 *   8/14/2026 11:25:33 AM | Resident(s) Ariauna Williams approved for move in
 *                           to unit 3714 DU-2 | Natalie Pointer
 *
 * Verified identical on every approved lease sampled, and absent on an
 * application that has not been approved yet — so its presence is itself the
 * approval signal, and a more reliable one than `approval_status`, which is
 * blank on the shallow skeletons the unit pass writes.
 *
 * The log is newest-first; the EARLIEST matching line is taken, because a
 * lease that was approved, transferred and re-approved should report when it
 * was first approved rather than the most recent administrative echo.
 */
/** One line of a lease's Activity Log, exactly as ResMan wrote it. */
export interface ActivityLogEntry {
  /** The timestamp cell verbatim — "8/13/2026 2:08:40 PM". */
  occurredAtText: string;
  /** Its date part, or null when the cell is not a date. */
  occurredOn: string | null;
  activity: string;
  performedBy: string;
  /** Oldest row = 0, counting up. Stable as the log grows: ResMan prepends. */
  sequence: number;
}

/**
 * Every row of the Activity Log, oldest-first by `sequence`.
 *
 * The log is stored whole rather than only the handful of fields the Pipeline
 * reads today. The page is already being fetched, and across 45 application
 * leases it held 797 rows in 394 distinct shapes — roommates added, income
 * records changed, documents uploaded, deposits added and deleted, recurring
 * charges edited, consent given, units transferred. Keeping only the 7 facts
 * we parse would mean re-scraping every lease the first time any of the rest
 * turns out to matter.
 *
 * The time of day is kept as TEXT, not a timestamptz. ResMan renders a local
 * wall-clock time with no zone, and stamping one on would be inventing
 * precision; `occurred_on` carries the date, which is what anything downstream
 * actually sorts and filters by.
 */
export function parseActivityLogRows(html: string): ActivityLogEntry[] {
  const rows: Omit<ActivityLogEntry, "sequence">[] = [];
  for (const row of rmsMatches(TR_PATTERN, html)) {
    if (row.length <= 1) continue;
    const cells = rmsMatches(TD_TH_PATTERN, row[1])
      .filter((m) => m.length > 1)
      .map((m) => trimmedForCell(stripTags(m[1])));
    if (cells.length < 2) continue;
    const [timestamp, activity] = cells;
    if (/^Timestamp$/i.test(timestamp)) continue;
    if (activity.length === 0) continue;
    rows.push({
      occurredAtText: timestamp,
      occurredOn: normalizeDate(timestamp.split(/\s+/)[0] ?? ""),
      activity,
      performedBy: cells.length > 2 ? cells[2] : "",
    });
  }
  // ResMan lists newest first. Numbering from the OLDEST makes the sequence
  // stable as new rows arrive — the same reason the ledger numbers this way.
  const total = rows.length;
  return rows.map((r, i) => ({ ...r, sequence: total - 1 - i }));
}

export interface ActivityLogFacts {
  /** "approved for move in" — the approval, and who recorded it. */
  approvedDate: string | null;
  approvedBy: string;
  /** The "Online Application" event: when the application actually arrived. */
  onlineApplicationDate: string | null;
  /** The FIRST start date the lease ever had, before any change. */
  originalStartDate: string | null;
  /** How many times the start date has been moved. */
  startDateChanges: number;
  /** A signature package went out to the applicant. */
  leaseSentDate: string | null;
  /** The lease was signed (either wording ResMan uses). */
  leaseSignedDate: string | null;
  /** A signature package was voided — a deal in trouble. */
  leaseVoidedDate: string | null;
}

const EMPTY_FACTS: ActivityLogFacts = {
  approvedDate: null,
  approvedBy: "",
  onlineApplicationDate: null,
  startDateChanges: 0,
  originalStartDate: null,
  leaseSentDate: null,
  leaseSignedDate: null,
  leaseVoidedDate: null,
};

/**
 * Everything worth having from a lease's Activity Log, in ONE pass over HTML
 * we are already fetching.
 *
 * The log is the only machine-emitted record of how an application moved.
 * Measured across the 45 application leases on this property (797 rows):
 *
 *   Online Application ........ 35 (78%) — and 31 of those leases have NO
 *                               application_date on the page, so this is the
 *                               only place the applied date exists for them
 *   lease Start Date changed .. 36 (80%) — 121 events; 35 of 36 moved LATER,
 *                               median 39 days, worst 196. A desired move-in
 *                               that keeps sliding looks identical to a firm
 *                               one on the board without this.
 *   approved for move in ...... the approval date
 *   Signature package sent .... 7 · signed 2 · VOIDED 2
 *
 * Rows are newest-first. Every field therefore keeps the EARLIEST match (the
 * loop overwrites as it descends into older rows), which is what "when did
 * this first happen" means; `startDateChanges` counts them all.
 */
export function parseActivityLog(html: string): ActivityLogFacts {
  const facts: ActivityLogFacts = { ...EMPTY_FACTS };
  // The oldest "changed from X" line holds the date the lease originally had.
  let oldestStartChange: string | null = null;

  for (const entry of parseActivityLogRows(html)) {
    const { activity, occurredOn: when } = entry;
    const cells = [entry.occurredAtText, entry.activity, entry.performedBy];
    if (when === null) continue;

    // "approved for move in" specifically. A bare /approv/ would also catch
    // "the lease Approval Status was changed…" and date the approval from an
    // administrative edit rather than the decision.
    if (/\bapproved for move in\b/i.test(activity)) {
      facts.approvedDate = when;
      facts.approvedBy = cells.length > 2 ? cells[2] : "";
      continue;
    }
    if (/^Online Application$/i.test(activity)) {
      facts.onlineApplicationDate = when;
      continue;
    }
    if (/\bSignature package\b.*\bwas sent to\b/i.test(activity)) {
      facts.leaseSentDate = when;
      continue;
    }
    if (/\bwas voided\b/i.test(activity)) {
      facts.leaseVoidedDate = when;
      continue;
    }
    // Two wordings: "…was signed on 8/1/2026" and "Resident(s) X signed their
    // lease for unit Y". The former carries the signing date in its own text,
    // which beats the row timestamp when they differ.
    const signedOn = /\bwas signed on\s+(\S+)/i.exec(activity);
    if (signedOn !== null) {
      facts.leaseSignedDate = normalizeDate(signedOn[1]) ?? when;
      continue;
    }
    if (/\bsigned their lease for unit\b/i.test(activity)) {
      facts.leaseSignedDate = when;
      continue;
    }
    const startChange = /\blease Start Date was changed from\s+(\S+)\s+to\b/i.exec(activity);
    if (startChange !== null) {
      facts.startDateChanges += 1;
      oldestStartChange = normalizeDate(startChange[1]) ?? oldestStartChange;
    }
  }

  facts.originalStartDate = oldestStartChange;
  return facts;
}

/** Fetch + parse a lease's Activity Log. One extra request per lease. */
export async function scrapeActivityLog(
  leaseId: string,
  http: ResManScrapeHttp,
): Promise<ActivityLogFacts> {
  return parseActivityLog(await http.getText(`/ActivityLog/ActivityLog?objectID=${leaseId}`));
}

/** Fetch + parse the combined "Employment & Other Income" tab. */
async function scrapeEmploymentTab(
  name: string,
  tabs: Record<string, string>,
  http: ResManScrapeHttp,
): Promise<Record<string, unknown>[]> {
  const ep = endpointNamed(name, tabs);
  if (ep === null) return [];
  return parseEmploymentTab(await http.getText(ep));
}

/**
 * Parse the "Employment & Other Income" tab. Each record is a main row
 * (Industry, Employer/Type, Title, Salary/Amount — positional) followed by a
 * hidden `detail-row` whose nested table carries Start date / Phone as `fl`/`fv`.
 * The block is segmented on the `id="employment{n}"` main-row marker so the
 * nested `<tr>`s inside the detail table never confuse row iteration.
 */
export function parseEmploymentTab(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const blocks = html.split(/(?=<tr\b[^>]*\bid="employment\d+")/i).slice(1);
  for (const block of blocks) {
    const cut = block.search(/class=["'][^"']*\bdetail-row\b/i);
    const mainPart = cut >= 0 ? block.slice(0, cut) : block;
    const detailPart = cut >= 0 ? block.slice(cut) : "";

    const cells = rmsMatches(TD_TH_PATTERN, mainPart)
      .filter((m) => m.length > 1)
      .map((m) => stripTags(m[1]));
    if (cells.length === 0) continue;

    // Positional main-row cells: [Industry, Employer/Type, Title, Salary/Amount].
    const industry = cells[0] ?? "";
    const employer = cells.length > 1 ? cells[1] : "";
    const title = cells.length > 2 ? cells[2] : "";
    const salary = cells.length > 3 ? cells[3] : (cells.length > 0 ? cells[cells.length - 1] : "");
    const amount = numOrNull(rmsFirstMatch("([\\d,]+(?:\\.\\d+)?)", salary) ?? "");
    // The Industry cell is what separates the two record kinds this one tab
    // holds: it reads literally "Other Income" on a non-employment record and
    // carries an industry (or nothing) on a job. The Employer/Type cell then
    // names the source — "Business", "General Assistance" — which is where
    // `other_income_source` comes from; it was mapped from a "Source" key
    // ResMan never sends and stayed empty on all 1,113 rows.
    const isOtherIncome = /other income/i.test(industry);

    const row: Record<string, unknown> = {};
    assignText(row, "Employer", employer);
    assignText(row, "Title", title);
    if (isOtherIncome) assignText(row, "Other Income Source", employer);
    if (amount !== null) {
      // Both figures are stored MONTHLY. Reading the amount straight off the
      // cell and calling anything not marked "(Monthly)" other income put
      // annual salaries in `other_income` — a $51,474/yr job recorded as
      // $51,474 of other income — and left `monthly_income` null for every
      // resident paid weekly, biweekly or annually.
      const monthly = monthlyFromPeriod(amount, salary);
      if (monthly !== null) row[isOtherIncome ? "Other Income" : "Income"] = monthly;
    }
    if (detailPart.length > 0) {
      assignText(row, "Phone", fvText(tabCellInner("e-phone-col", detailPart)));
      assignText(row, "Start Date", fvText(tabCellInner("e-start-date-col", detailPart)));
    }
    if (Object.keys(row).length > 0) out.push(row);
  }
  return out;
}

/** Fetch + parse the Addresses tab. */
async function scrapeAddressesTab(
  name: string,
  tabs: Record<string, string>,
  http: ResManScrapeHttp,
): Promise<Record<string, unknown>[]> {
  const ep = endpointNamed(name, tabs);
  if (ep === null) return [];
  return parseAddressesTab(await http.getText(ep));
}

/**
 * Parse the Addresses tab (real header row: Type, Street, City/State/Zip,
 * Default). Only `<tbody>` rows carrying `data-item-id` are data rows; the
 * combined City/State/Zip cell is split into city/state/postal_code/country.
 */
export function parseAddressesTab(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const rowMatch of rmsMatches(TR_PATTERN, html)) {
    if (rowMatch.length <= 1) continue;
    if (!/\bdata-item-id=/i.test(rowMatch[0])) continue;
    const cells = rmsMatches(TD_TH_PATTERN, rowMatch[1])
      .filter((m) => m.length > 1)
      .map((m) => stripTags(m[1]));
    if (cells.length < 3) continue;

    const row: Record<string, unknown> = {};
    assignText(row, "Type", cells[0]);
    assignText(row, "Street", cells[1]);
    // Combined "City, ST 12345 Country" cell — split into components, tolerating
    // a missing ZIP or missing country.
    const csz = cells[2];
    const full = /^(.+?),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\s*(.*)$/.exec(csz);
    const cityState = /^(.+?),\s*([A-Za-z]{2})\b\s*(.*)$/.exec(csz);
    if (full) {
      assignText(row, "City", full[1]);
      assignText(row, "State", full[2]);
      assignText(row, "Zip", full[3]);
      assignText(row, "Country", full[4]);
    } else if (cityState) {
      assignText(row, "City", cityState[1]);
      assignText(row, "State", cityState[2]);
      assignText(row, "Country", cityState[3]);
    } else {
      assignText(row, "City", csz);
    }
    if (Object.keys(row).length > 0) out.push(row);
  }
  return out;
}

/** Fetch + parse the Alternate Contacts tab. */
async function scrapeAlternateContactsTab(
  name: string,
  tabs: Record<string, string>,
  http: ResManScrapeHttp,
): Promise<Record<string, unknown>[]> {
  const ep = endpointNamed(name, tabs);
  if (ep === null) return [];
  return parseAlternateContactsTab(await http.getText(ep));
}

/**
 * Parse the Alternate Contacts tab (header row: Resident, Name, Relationship,
 * Phone, Email, Emergency). Only `data-item-id` main rows are records; the
 * "Emergency" cell is a checkmark icon (no text), so presence is detected, and
 * the trailing hidden `detail-row` is skipped.
 */
export function parseAlternateContactsTab(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const rowMatch of rmsMatches(TR_PATTERN, html)) {
    if (rowMatch.length <= 1) continue;
    if (!/\bdata-item-id=/i.test(rowMatch[0])) continue;
    const rowHTML = rowMatch[1];

    const row: Record<string, unknown> = {};
    assignText(row, "Name", stripTags(tabCellInner("a-name-col", rowHTML)));
    assignText(row, "Relationship", stripTags(tabCellInner("a-relationship-col", rowHTML)));
    assignText(row, "Phone", stripTags(tabCellInner("a-phone-col", rowHTML)));
    assignText(row, "Email", stripTags(tabCellInner("a-email-col", rowHTML)));
    const emergencyCell = tabCellInner("a-emergency-contact-col", rowHTML);
    row["Emergency Contact"] = /fa-check|ui-icon-check|checkmark/i.test(emergencyCell);
    if (Object.keys(row).length > 0) out.push(row);
  }
  return out;
}

/**
 * Set `key` to the trimmed string `value`, skipping blanks. These tab fields are
 * consumed by the residents.ts mappers via `pick()`, which only accepts STRING
 * values — so values must stay strings (coercing e.g. a ZIP "38116" to a number
 * would make `pick()` skip it and the column would land empty).
 */
function assignText(row: Record<string, unknown>, key: string, value: string): void {
  const t = value.trim();
  if (t.length > 0) row[key] = t;
}

// MARK: - Field-level parse helpers

/**
 * Find the `<div class="fv">` value for a label identified by its `for=`
 * attribute, spanning `<td>` boundaries. Port of `labelForValue(_:in:)`.
 */
function labelForValue(forAttr: string, html: string): string | null {
  const result = rmsFirstMatch(
    `<label\\b[^>]*\\bfor="${forAttr}"[^>]*>.*?</label>.*?<div[^>]*\\bclass=["'][^"']*\\bfv\\b[^"']*["'][^>]*>(.*?)</div>`,
    html,
  );
  if (result === null) return null;
  return nilIfBlank(result) ?? null;
}

/**
 * Parse the unit address from nested `<div class="model-street-address">` lines.
 * Port of `parseUnitAddress(from:)`.
 */
function parseUnitAddress(html: string): Record<string, unknown> {
  const lines = rmsMatches(MODEL_STREET_PATTERN, html)
    .map((match) => {
      if (match.length <= 1) return null;
      return nilIfBlank(trimmedForCell(match[1].replace(/\s+/g, " "))) ?? null;
    })
    .filter((s): s is string => s !== null);
  if (lines.length === 0) return {};

  const result: Record<string, unknown> = { street: lines[0] };
  if (lines.length >= 2) {
    const cityStateZip = lines[1];
    const matches = rmsMatches(CITY_STATE_ZIP_PATTERN, cityStateZip);
    const m = matches.length > 0 ? matches[0] : undefined;
    if (m !== undefined && m.length >= 4) {
      result.city = m[1];
      result.state = m[2];
      result.postalCode = m[3];
    } else {
      result.cityStateZip = cityStateZip;
    }
  }
  if (lines.length >= 3) result.country = lines[2];
  return result;
}

/** Port of `firstFloorplanText(in:)`. */
function firstFloorplanText(html: string): string | null {
  const m = rmsFirstMatch(FLOORPLAN_TEXT_PATTERN, html);
  return m === null ? null : stripTags(m);
}

/** Port of `moneyCategory(_:)` — returns a compacted `{category?, amount?}` dict. */
function moneyCategory(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  const parts = text.split(" - ");
  if (parts.length >= 2) {
    return compact({ category: trimmedForCell(parts[0]), amount: numOrNull(parts[1]) });
  }
  return compact({ amount: numOrNull(text) });
}

/** Port of `daysVacant(_:)` → `{current, lifetime}` from a `current/lifetime` cell. */
function daysVacant(text: string | undefined): { current: number | null; lifetime: number | null } {
  if (text === undefined) return { current: null, lifetime: null };
  const parts = text.split("/").map((p) => trimmedForCell(p));
  return {
    current: parts.length > 0 ? intOrNull(parts[0]) : null,
    lifetime: parts.length > 1 ? intOrNull(parts[1]) : null,
  };
}

/**
 * Convert a "Salary / Amount" cell to a MONTHLY figure.
 *
 * The cell reads "$1,500.00 (Biweekly)" — the amount is per pay period, and the
 * period is the only thing that makes two residents' incomes comparable. The
 * mirror stores monthly throughout, so everything is normalized here.
 *
 *   - a recognised period converts;
 *   - no parenthetical at all is taken as monthly (ResMan's own default);
 *   - an unrecognised period — "Hourly", with no hours anywhere on the page —
 *     yields null. A guessed 40-hour week would read as a measured figure in
 *     the affordability math, and null is the honest answer.
 */
export function monthlyFromPeriod(amount: number, salaryCell: string): number | null {
  const period = (/\(([^)]*)\)/.exec(salaryCell)?.[1] ?? "").trim().toLowerCase();
  if (period.length === 0) return amount;
  if (/^month/.test(period)) return amount;
  if (/^(annual|year)/.test(period)) return amount / 12;
  if (/^(semi.?month|twice.?a.?month)/.test(period)) return amount * 2;
  if (/^(bi.?week|every.?(other|two).?week|fortnight)/.test(period)) return (amount * 26) / 12;
  if (/^week/.test(period)) return (amount * 52) / 12;
  return null;
}

/**
 * "Pets permitted" is either Yes/No or a numeric count; any positive count →
 * true. Port of `petsPermittedBool(_:)`.
 */
function petsPermittedBool(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const v = trimmedForCell(value);
  if (v.length === 0) return null;
  const b = yesNo(v);
  if (b !== null) return b;
  const n = intOrNull(v);
  if (n !== null) return n > 0;
  return null;
}

/** Port of `propertyName(from:)` — first lease's `propertyName` string. */
function propertyName(leases: Record<string, unknown>[]): string | null {
  for (const lease of leases) {
    const v = lease.propertyName;
    if (typeof v === "string") return v;
  }
  return null;
}

/** Port of `parseDateRange(_:)` — splits a `start - end` cell into ISO dates. */
function parseDateRange(value: string): { start: string | null; end: string | null } {
  const parts = value.split(" - ").map((p) => normalizeDate(p));
  return {
    start: parts.length > 0 ? parts[0] : null,
    end: parts.length > 1 ? parts[1] : null,
  };
}

// MARK: - Scalar normalization

/**
 * Coerce a cell string to bool / ISO-date / number / trimmed-string, or null
 * when blank. Port of `normalizeScalar(_:)` (`NSNull()` → `null`).
 */
function normalizeScalar(value: string): string | number | boolean | null {
  const clean = trimmedForCell(value);
  if (clean.length === 0) return null;
  const bool = yesNo(clean);
  if (bool !== null) return bool;
  const date = normalizeDate(clean);
  if (date !== null && DATE_SCALAR_RE.test(clean)) return date;
  const number = numOrNull(clean);
  if (number !== null && NUMBER_SCALAR_RE.test(clean)) return number;
  return clean;
}

// MARK: - Names / phones / drivers license


/**
 * Extract, dedupe, and format phone numbers as `(XXX) XXX-XXXX`. Port of
 * `extractPhones(_:)`.
 */
function extractPhones(text: string): string[] {
  const candidates = rmsMatches(PHONE_PATTERN, text)
    .map((m) => (m.length > 0 ? m[0] : undefined))
    .filter((s): s is string => s !== undefined);

  const seen = new Set<string>();
  for (const raw of candidates) {
    const digits = raw.replace(/\D/g, "");
    let ten: string;
    if (digits.length === 11 && digits.startsWith("1")) {
      ten = digits.slice(1);
    } else if (digits.length === 10) {
      ten = digits;
    } else {
      continue;
    }
    seen.add(`(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`);
  }
  return [...seen].sort();
}

/** Port of `isStateOnlyDL(_:)` — a bare 2-letter uppercase state abbreviation. */
function isStateOnlyDL(value: string): boolean {
  const v = trimmedForCell(value);
  return v.length === 2 && v === v.toUpperCase() && /^[A-Za-z]+$/.test(v);
}

/** Port of `driversLicenseNumber(_:)` — the number before the `\` (or null). */
function driversLicenseNumber(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  if (!raw.includes("\\")) {
    return isStateOnlyDL(raw) ? undefined : nilIfBlank(trimmedForCell(raw));
  }
  return nilIfBlank(trimmedForCell(raw.split("\\")[0]));
}

/** Port of `driversLicenseState(_:)` — the state after the `\` (or the bare state). */
function driversLicenseState(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!raw.includes("\\")) {
    return isStateOnlyDL(raw) ? trimmedForCell(raw) : undefined;
  }
  const parts = raw.split("\\");
  return parts.length > 1 ? nilIfBlank(trimmedForCell(parts[parts.length - 1])) : undefined;
}

// MARK: - BuildingFloorplans JSON decode

function decodeBuildingFloorplans(json: unknown, endpoint: string): BuildingFloorplans {
  try {
    const obj = asObject(json);
    const buildings = asArray(obj.buildings).map(decodeBuildingLookup);
    const floorplans = asArray(obj.unitTypes).map(decodeFloorplanLookup);
    return { buildings, floorplans };
  } catch {
    throw ResManScrapingError.parsingFailed(`Invalid JSON from ${endpoint}`);
  }
}

function decodeBuildingLookup(value: unknown): BuildingLookup {
  const o = asObject(value);
  return { BuildingID: reqString(o, "BuildingID"), Name: reqString(o, "Name") };
}

function decodeFloorplanLookup(value: unknown): FloorplanLookup {
  const o = asObject(value);
  return {
    floorplanId: reqString(o, "UnitTypeID"),
    Name: reqString(o, "Name"),
    Description: optString(o, "Description"),
    AllowsMultipleLeases: reqBool(o, "AllowsMultipleLeases"),
    SquareFootage: optNumber(o, "SquareFootage"),
    TotalUnits: optNumber(o, "TotalUnits"),
    NameAndDescription: optString(o, "NameAndDescription"),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected array");
  return value;
}

function reqString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string") throw new Error(`expected string for ${key}`);
  return v;
}

function reqBool(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") throw new Error(`expected bool for ${key}`);
  return v;
}

function optString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new Error(`expected string for ${key}`);
  return v;
}

function optNumber(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number") throw new Error(`expected number for ${key}`);
  return v;
}

// MARK: - Small utilities

/**
 * Set `key` on `dict` only when `value` is neither null nor undefined — the TS
 * form of the Swift `if let v = … { dict[key] = v }` idiom.
 */
function assignIfPresent(
  dict: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== null && value !== undefined) dict[key] = value;
}

/** Drop null/undefined/empty-string values (keeps `false`/`0`). Port of `compact(_:)`. */
function compact(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/** Trimmed value, or undefined when blank. Port of `String.nilIfBlank`. */
function nilIfBlank(value: string): string | undefined {
  const t = value.trim();
  return t.length === 0 ? undefined : t;
}

/** Swift `localizedCaseInsensitiveContains`. */
function containsCaseInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** First `fields` entry whose key starts with "Identification" (fallback). */
function firstIdentification(fields: Record<string, string>): string | undefined {
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("Identification")) return value;
  }
  return undefined;
}
