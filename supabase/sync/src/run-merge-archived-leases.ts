/**
 * ONE-OFF: bring over the archived properties' leases that the live property
 * does not already have.
 *
 *   RESMAN_ARCHIVED_PROPERTY_IDS=<id1>,<id2>,<id3> bun run sync:merge-archived-leases
 *   RESMAN_ARCHIVED_PROPERTY_IDS=<id1>,<id2>,<id3> bun run sync:merge-archived-leases --apply
 *
 * THE LIVE PROPERTY IS AUTHORITATIVE. Its record is the current state of the
 * door in ResMan, whatever status the lease carries. So a lease that exists on
 * both sides is DROPPED, not merged — the live row stands. Only archived leases
 * with no live counterpart come over, as history.
 *
 * Consequence, stated plainly because it is a real cost: a tenancy that straddles
 * the merge keeps only its live ledger. Unit 1709 CW-1 is the worked example —
 * Mario Shannon's tenancy has 162 archived ledger entries covering 2025-02-20 →
 * 2026-02-05 and 41 live ones covering 2026-02-16 → 2026-02-25, with zero
 * overlap. Skipping the archived lease keeps the 41 and discards the 162.
 *
 * MATCHING, since no id survived the merge. ResMan re-minted properties, units,
 * leases AND persons; the only things that carried over are unit numbers, dates
 * and human names. So a lease is matched on `unit + start + end + residents`,
 * with `unit + start + end` as a fallback tier — past and pending leases come
 * back from the lease-history table as skeletons with no resident identity, and
 * without the fallback every one of those would import as a duplicate of a live
 * lease it plainly is. Both tiers are counted separately in the report so the
 * weaker one stays visible.
 *
 * IMPORTED LEASES ARE MARKED NEITHER CURRENT NOR MOST-RECENT. This is not
 * cosmetic. `syncLeaseDetails` selects its work with
 * `is_current_lease OR is_most_recent_lease` scoped to the live property, so an
 * imported archived lease left with either flag set would be handed to the
 * nightly job, which would try to scrape an archived lease id against the live
 * property id. They are history; they are flagged as history.
 *
 * NOT COVERED: units and work orders, which live in
 * run-merge-archived-properties.ts. Units in particular must not be imported —
 * the archived properties hold the same 891 doors under different GUIDs.
 *
 * DRY RUN IS THE DEFAULT. Without --apply it scrapes, classifies and reports,
 * writing nothing. `--limit N` bounds the units scraped per property for a first
 * look; a full pass is ~891 unit pages and takes well over an hour.
 */
import { ENV } from "./config/env";
import { createServiceClient, upsertMirror, type ServiceClient } from "./db/client";
import { ResManClient } from "./resman/client";
import { resManConfigurationFromEnv, resManCredentialsFromEnv } from "./resman/config";
import { CsvHeaderLookup, decodeCsvRows } from "./resman/csv";
import { mapLedgerRows } from "./resman/scrapers/ledger";
import {
  classifyArchivedLease,
  leaseTermKey,
  residentKey,
  type LiveLeaseIndex,
} from "./resman/merge-archived";
import { ResManReportService } from "./resman/report-service";
import { buildAllUnitsEndpoint, buildAllUnitsForm, formatAsOfDate } from "./resman/reports/all-units";
import { mapLease } from "./resman/scrapers/leases";
import { ResManScrapeHttp, mapWithConcurrency } from "./resman/scrapers/http";
import { mapResidents } from "./resman/scrapers/residents";
import { scrapeUnit } from "./resman/scrapers/unit-detail";
import { parseLedgerDate, str } from "./resman/scrapers/parse";
import { vehicleIdentityKey } from "./resman/normalize";
import { withLock } from "./shared/run-lock";

type Dict = Record<string, unknown>;
const asRows = (rows: readonly unknown[]): Array<Record<string, unknown>> =>
  rows as Array<Record<string, unknown>>;
const dictArray = (value: unknown): Dict[] =>
  Array.isArray(value) ? value.filter((v): v is Dict => v !== null && typeof v === "object") : [];

/** unit number → live resman_unit_id. The only bridge between the two sides. */
async function loadLiveUnitIdByNumber(
  supabase: ServiceClient,
  propertyId: string,
): Promise<Map<string, string>> {
  const byNumber = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("resman_units")
      .select("resman_unit_id, number")
      .eq("resman_property_id", propertyId)
      .order("resman_unit_id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`read resman_units failed: ${error.message}`);
    const batch = (data ?? []) as unknown as Array<{ resman_unit_id: string; number: string }>;
    for (const u of batch) {
      const key = (u.number ?? "").trim();
      if (key.length > 0 && !byNumber.has(key)) byNumber.set(key, u.resman_unit_id);
    }
    if (batch.length < 1000) break;
  }
  return byNumber;
}

/**
 * Every live lease, keyed both ways. Residents are joined in because names are
 * the only household identity that survived the merge.
 */
async function loadLiveLeaseIndex(
  supabase: ServiceClient,
  propertyId: string,
): Promise<LiveLeaseIndex & { leaseCount: number; datedCount: number }> {
  const leases: Array<{
    resman_lease_id: string;
    unit_number: string;
    start_date: string | null;
    end_date: string | null;
  }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("resman_leases")
      .select("resman_lease_id, unit_number, start_date, end_date")
      .eq("resman_property_id", propertyId)
      .order("resman_lease_id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`read resman_leases failed: ${error.message}`);
    const batch = (data ?? []) as unknown as typeof leases;
    leases.push(...batch);
    if (batch.length < 1000) break;
  }

  const namesByLease = new Map<string, string[]>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("resman_residents")
      .select("resman_lease_id, first_name, last_name")
      .order("resman_person_lease_id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`read resman_residents failed: ${error.message}`);
    const batch = (data ?? []) as unknown as Array<{
      resman_lease_id: string;
      first_name: string | null;
      last_name: string | null;
    }>;
    for (const r of batch) {
      const list = namesByLease.get(r.resman_lease_id) ?? [];
      list.push(`${r.first_name ?? ""} ${r.last_name ?? ""}`);
      namesByLease.set(r.resman_lease_id, list);
    }
    if (batch.length < 1000) break;
  }

  const byTermAndResidents = new Map<string, string>();
  const byTerm = new Map<string, string[]>();
  let datedCount = 0;
  for (const l of leases) {
    if (!l.start_date && !l.end_date) continue;
    datedCount += 1;
    const term = leaseTermKey(l.unit_number, l.start_date, l.end_date);
    byTerm.set(term, [...(byTerm.get(term) ?? []), l.resman_lease_id]);
    const residents = residentKey(namesByLease.get(l.resman_lease_id) ?? []);
    if (residents.length > 0 && !byTermAndResidents.has(`${term}|${residents}`)) {
      byTermAndResidents.set(`${term}|${residents}`, l.resman_lease_id);
    }
  }
  return { byTermAndResidents, byTerm, leaseCount: leases.length, datedCount };
}

/** The archived property's units, straight from its All-Units report. */
async function fetchArchivedUnitList(
  service: ResManReportService,
  client: ResManClient,
  archivedId: string,
): Promise<Array<{ resman_unit_id: string; number: string }>> {
  const endpoint = buildAllUnitsEndpoint(client.configuration);
  const context = await service.loadViewerContext(endpoint);
  const fields = buildAllUnitsForm(context, {
    propertyOrGroupId: archivedId,
    asOfDate: formatAsOfDate(new Date()),
  });
  const { rows } = decodeCsvRows(await service.exportCSV(endpoint, fields));
  if (rows.length < 2) return [];
  const lookup = new CsvHeaderLookup(rows[0]);
  const out: Array<{ resman_unit_id: string; number: string }> = [];
  for (const row of rows.slice(1)) {
    const id = lookup.value(row, "UnitId").trim();
    const number = lookup.value(row, "Unit").trim();
    if (id.length > 0 && number.length > 0) out.push({ resman_unit_id: id, number });
  }
  return out;
}

interface Tally {
  unitsScraped: number;
  unitsFailed: number;
  leasesSeen: number;
  skippedResidentAndTerm: number;
  skippedTermOnly: number;
  unkeyable: number;
  noLiveUnit: number;
  imported: number;
  ledgerRows: number;
  residentRows: number;
}

const emptyTally = (): Tally => ({
  unitsScraped: 0, unitsFailed: 0, leasesSeen: 0, skippedResidentAndTerm: 0,
  skippedTermOnly: 0, unkeyable: 0, noLiveUnit: 0, imported: 0, ledgerRows: 0, residentRows: 0,
});

async function main(): Promise<void> {
  const env = process.env;
  const argv = process.argv;
  const apply = argv.includes("--apply");
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const unitLimit = limitArg ? Number.parseInt(limitArg.slice("--limit=".length), 10) : undefined;

  const writePropertyId = env[ENV.RESMAN_PROPERTY_ID]?.trim();
  if (!writePropertyId) throw new Error(`Missing required environment variable: ${ENV.RESMAN_PROPERTY_ID}`);

  const archivedIds = (env.RESMAN_ARCHIVED_PROPERTY_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (archivedIds.length === 0) {
    throw new Error("Missing required environment variable: RESMAN_ARCHIVED_PROPERTY_IDS");
  }
  if (archivedIds.includes(writePropertyId)) {
    throw new Error(`RESMAN_ARCHIVED_PROPERTY_IDS contains the live property ${writePropertyId}`);
  }

  const intEnv = (key: string): number | undefined => {
    const raw = env[key]?.trim();
    return raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined;
  };
  const connectionsPerHost = intEnv("RESMAN_CONNECTIONS_PER_HOST");
  const concurrency = intEnv("RESMAN_UNIT_CONCURRENCY") ?? connectionsPerHost ?? 6;

  const supabase = createServiceClient(env);
  const credentials = resManCredentialsFromEnv(env);
  const client = new ResManClient(resManConfigurationFromEnv(env), {
    credentials,
    connectionsPerHost,
    log: (m) => console.log(m),
  });

  console.log(`[leases] ${apply ? "APPLY" : "DRY RUN (nothing will be written — pass --apply to write)"}`);
  console.log(`[leases] live property: ${writePropertyId}`);
  console.log(`[leases] archived:      ${archivedIds.join(", ")}`);
  if (unitLimit) console.log(`[leases] --limit=${unitLimit} units per archived property`);

  await client.ensureAuthenticated(credentials);
  const service = ResManReportService.fromClient(client);
  const http = new ResManScrapeHttp(client);

  const [unitIdByNumber, liveLeases] = await Promise.all([
    loadLiveUnitIdByNumber(supabase, writePropertyId),
    loadLiveLeaseIndex(supabase, writePropertyId),
  ]);
  console.log(
    `[leases] live: ${unitIdByNumber.size} units, ${liveLeases.leaseCount} leases ` +
      `(${liveLeases.datedCount} with a term, ${liveLeases.byTermAndResidents.size} keyed by household)`,
  );

  const grand = emptyTally();

  for (const archivedId of archivedIds) {
    console.log(`\n[leases] ---- ${archivedId} ----`);
    const tally = emptyTally();

    let units = await fetchArchivedUnitList(service, client, archivedId);
    if (unitLimit !== undefined) units = units.slice(0, unitLimit);
    console.log(`[leases] ${units.length} archived unit${units.length === 1 ? "" : "s"} to scrape`);
    if (units.length === 0) continue;

    const leaseRows: Array<Record<string, unknown>> = [];
    const txRows: Array<Record<string, unknown>> = [];
    const residentRows: Array<Record<string, unknown>> = [];
    const vehicleRows: Array<Record<string, unknown>> = [];
    const employmentRows: Array<Record<string, unknown>> = [];
    const insuranceRows: Array<Record<string, unknown>> = [];
    const addressRows: Array<Record<string, unknown>> = [];
    const altContactRows: Array<Record<string, unknown>> = [];
    const seenVehicles = new Set<string>();
    const importedSamples: string[] = [];

    let done = 0;
    const results = await mapWithConcurrency(units, concurrency, async (unit) => {
      try {
        const data = await scrapeUnit(unit.resman_unit_id, http, { knownPropertyId: archivedId });
        done += 1;
        if (done % 25 === 0) console.log(`[leases]   scraped ${done}/${units.length}`);
        return { unit, data };
      } catch (error) {
        tally.unitsFailed += 1;
        done += 1;
        console.log(`[leases] ✗ ${unit.number} — ${(error as Error).message}`);
        return null;
      }
    });

    for (const entry of results) {
      if (entry === null) continue;
      tally.unitsScraped += 1;
      const { unit, data } = entry;
      const liveUnitId = unitIdByNumber.get(unit.number);

      for (const leaseData of dictArray((data as Dict)["leases"])) {
        tally.leasesSeen += 1;
        const names = dictArray(leaseData["residents"]).map(
          (r) => `${str(r, "firstName")} ${str(r, "lastName")}`.trim() || str(r, "fullName"),
        );
        // Through parseLedgerDate, not raw. The live side of the key is the DB's
        // `date` column (ISO); ResMan currently returns ISO here too, but it
        // returns M/D/YYYY elsewhere in the same payload, and a silent format
        // drift would make every lease look new and import 891 duplicates.
        const verdict = classifyArchivedLease(
          {
            unitNumber: unit.number,
            startDate: parseLedgerDate(str(leaseData, "leaseStartDate")),
            endDate: parseLedgerDate(str(leaseData, "leaseEndDate")),
            residentNames: names,
          },
          liveLeases,
          liveUnitId !== undefined,
        );

        if (verdict.kind === "noLiveUnit") { tally.noLiveUnit += 1; continue; }
        if (verdict.kind === "unkeyable") { tally.unkeyable += 1; continue; }
        if (verdict.kind === "skip") {
          if (verdict.reason === "resident-and-term") tally.skippedResidentAndTerm += 1;
          else tally.skippedTermOnly += 1;
          continue;
        }

        // Import: re-pointed onto the live unit, flagged as history.
        tally.imported += 1;
        const unitId = liveUnitId as string;
        const leaseRow = mapLease(leaseData, {
          unitId,
          unitNumber: unit.number,
          propertyId: writePropertyId,
          isMostRecent: false,
        });
        // Never hand an archived lease id to the nightly lease-details job — it
        // selects on these two flags scoped to the live property and would scrape
        // an id that does not exist there.
        leaseRow.is_current_lease = false;
        leaseRow.is_most_recent_lease = false;
        if (leaseData._deepCaptured === true) leaseRow.deep_synced_at = new Date().toISOString();
        leaseRows.push(leaseRow as unknown as Record<string, unknown>);
        if (importedSamples.length < 5) {
          importedSamples.push(
            `${unit.number} ${leaseRow.status} ${leaseRow.start_date}→${leaseRow.end_date} ` +
              `(${dictArray(leaseData["ledger"]).length} ledger)`,
          );
        }

        const leaseId = str(leaseData, "leaseId");
        const ledger = mapLedgerRows(dictArray(leaseData["ledger"]), {
          leaseId,
          unitId,
          propertyId: writePropertyId,
        });
        tally.ledgerRows += ledger.length;
        txRows.push(...asRows(ledger));

        const mapped = mapResidents(dictArray(leaseData["residents"]), { leaseId });
        tally.residentRows += mapped.residents.length;
        residentRows.push(...asRows(mapped.residents));
        for (const v of mapped.vehicles) {
          const key = vehicleIdentityKey(unitId, v);
          if (seenVehicles.has(key)) continue;
          seenVehicles.add(key);
          vehicleRows.push(v as unknown as Record<string, unknown>);
        }
        employmentRows.push(...asRows(mapped.employment));
        insuranceRows.push(...asRows(mapped.insurance));
        addressRows.push(...asRows(mapped.addresses));
        altContactRows.push(...asRows(mapped.alternateContacts));
      }
    }

    console.log(
      `[leases] units ok=${tally.unitsScraped} failed=${tally.unitsFailed} | leases seen=${tally.leasesSeen}\n` +
        `[leases]   skipped, live lease matched on term+household: ${tally.skippedResidentAndTerm}\n` +
        `[leases]   skipped, live lease matched on term only:      ${tally.skippedTermOnly}\n` +
        `[leases]   skipped, no live unit with that number:        ${tally.noLiveUnit}\n` +
        `[leases]   skipped, no term to match on:                  ${tally.unkeyable}\n` +
        `[leases]   TO IMPORT:                                     ${tally.imported}` +
        ` (${tally.ledgerRows} ledger rows, ${tally.residentRows} residents)`,
    );
    for (const s of importedSamples) console.log(`[leases]     e.g. ${s}`);

    if (apply && leaseRows.length > 0) {
      // FK-safe waves, same order as the real job: leases → residents → the rest.
      const l = await upsertMirror(supabase, "resman_leases", leaseRows, { conflictColumn: "resman_lease_id" });
      const r = await upsertMirror(supabase, "resman_residents", residentRows, { conflictColumn: "resman_person_lease_id" });
      const [t, v, e, i, a, c] = await Promise.all([
        upsertMirror(supabase, "resman_transactions", txRows, { conflictColumn: "resman_ledger_entry_id" }),
        upsertMirror(supabase, "resman_lease_vehicles", vehicleRows, { conflictColumn: "resman_vehicle_id" }),
        upsertMirror(supabase, "resman_lease_employment", employmentRows, { conflictColumn: "resman_employment_id" }),
        upsertMirror(supabase, "resman_lease_insurance", insuranceRows, { conflictColumn: "resman_insurance_id" }),
        upsertMirror(supabase, "resman_lease_addresses", addressRows, { conflictColumn: "resman_address_id" }),
        upsertMirror(supabase, "resman_lease_alternate_contacts", altContactRows, { conflictColumn: "resman_contact_id" }),
      ]);
      console.log(
        `[leases] written: leases=${l.upserted} residents=${r.upserted} transactions=${t.upserted} ` +
          `vehicles=${v.upserted} employment=${e.upserted} insurance=${i.upserted} addresses=${a.upserted} contacts=${c.upserted}`,
      );
    }

    for (const k of Object.keys(grand) as Array<keyof Tally>) grand[k] += tally[k];
  }

  console.log("\n[leases] ================ summary ================");
  console.log(`[leases] leases seen across all archived properties: ${grand.leasesSeen}`);
  console.log(`[leases]   already in the live property (term+household): ${grand.skippedResidentAndTerm}`);
  console.log(`[leases]   already in the live property (term only):      ${grand.skippedTermOnly}`);
  console.log(`[leases]   no live unit / no term:                        ${grand.noLiveUnit} / ${grand.unkeyable}`);
  console.log(`[leases]   imported as history:                           ${grand.imported}`);
  console.log(`[leases]   with ${grand.ledgerRows} ledger rows and ${grand.residentRows} residents`);
  if (!apply) console.log("[leases] DRY RUN — nothing was written. Re-run with --apply to commit.");
}

// One ResMan scraper at a time — the request ceiling is per process.
withLock("resman", "run-merge-archived-leases", main)
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("[run-merge-archived-leases] failed:", error);
    process.exit(1);
  });
