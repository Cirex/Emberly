/**
 * ONE-OFF: pull three archived ResMan properties into the property we use now.
 *
 *   RESMAN_ARCHIVED_PROPERTY_IDS=<id1>,<id2>,<id3> bun run src/run-merge-archived-properties.ts
 *   RESMAN_ARCHIVED_PROPERTY_IDS=<id1>,<id2>,<id3> bun run src/run-merge-archived-properties.ts --apply
 *
 * The current property was once split across three properties that are now
 * archived — `X - Emberly Apartments`, `X - Emberly East`, `X - Emberly West`.
 * This fetches their reports and writes the rows under RESMAN_PROPERTY_ID, the
 * property we use today, so the history lands where the apps already look.
 *
 * WHAT THE ARCHIVED PROPERTIES ACTUALLY CONTAIN — measured, 2026-08-11:
 *
 *     X - Emberly Apartments   387 units   3,235 work orders
 *     X - Emberly East         202 units   1,636 work orders
 *     X - Emberly West         302 units   2,795 work orders
 *     ----------------------------------------------------------
 *                              891 units   7,666 work orders
 *
 * 891 is exactly the live unit count, and NOT ONE archived unit id matches a
 * live one — 882 of them collide by unit NUMBER instead. ResMan minted fresh
 * unit records when the properties were combined, so the archived inventory is
 * the same doors under different GUIDs. Importing it would not add units; it
 * would duplicate all 891.
 *
 * So units are SKIPPED by default and the work orders are the point. 99.5% of
 * them (7,624 of 7,666) resolve to a live unit id by unit number, which is the
 * one identifier that survived the merge. `--with-units` still exists for the
 * day that stops being true; it will tell you the collision count first.
 *
 * WHY THIS IS A SCRIPT AND NOT A FLAG ON THE REAL JOBS. It runs once, against
 * data that is frozen. Threading a write-property override through syncUnits and
 * syncWorkOrders would put a second, rarely-exercised code path inside the two
 * jobs that run on a schedule against live data, and the payoff would expire the
 * day this finishes. So the shared mappers are reused and the orchestration is
 * local, where it can be read in one sitting and deleted afterwards.
 *
 * WHAT IT DOES NOT DO — deliberately:
 *
 *   - No delete-missing, anywhere. Both real jobs scope delete-missing to the
 *     property they scraped; here the scrape covers a fraction of the write
 *     scope, so every row you already have would look "missing". The 0.35 floor
 *     guard in upsertMirror would refuse the delete, but being saved by a safety
 *     net is not a plan. It is simply never asked for.
 *
 *   - Units are skipped, and under `--with-units` they are INSERT-ONLY: an
 *     archived unit id that already exists is left alone. An archived report is
 *     a frozen snapshot, and upserting it would push stale occupancy, tenant
 *     names and balances over the live row. (Against today's data this guard
 *     never fires — no ids overlap at all — which is exactly why the default is
 *     to skip the table rather than to rely on it.)
 *
 *   - It does not touch resman_properties. The three archived rows are never
 *     created, because nothing is written under their ids. Note that
 *     resman_properties cascades on delete — if you later add and remove those
 *     rows by hand, anything still pointing at them goes too.
 *
 * DRY RUN IS THE DEFAULT. Without --apply it fetches, maps, and prints exactly
 * what would be written — row counts, how many work orders resolved to a live
 * unit, and the status breakdown — then exits having changed nothing.
 *
 * NOT COVERED HERE: leases, residents and ledgers. Those come from the per-unit
 * deep scrape, which walks each unit's own history page, so the live units
 * already carry theirs back to 2020-07-01. Reaching the archived units' lease
 * records would mean deep-scraping archived unit ids and re-pointing every row
 * by unit number — a different job from this one, and only worth doing if
 * something is actually found to be missing.
 */
import { ENV } from "./config/env";
import { createServiceClient, upsertMirror, type ServiceClient } from "./db/client";
import { ResManClient } from "./resman/client";
import { resManConfigurationFromEnv, resManCredentialsFromEnv } from "./resman/config";
import { CsvHeaderLookup, decodeCsvRows } from "./resman/csv";
import {
  classifyUnitRow,
  type LiveUnitIndex,
  type UnitNumberCollision,
} from "./resman/merge-archived";
import { ResManReportService } from "./resman/report-service";
import {
  buildAllUnitsEndpoint,
  buildAllUnitsForm,
  formatAsOfDate,
  mapAllUnitsRow,
} from "./resman/reports/all-units";
import {
  buildWorkOrdersEndpoint,
  buildWorkOrdersForm,
  firstAccountingPeriod,
  formatWorkOrderDate,
  mapWorkOrderRow,
} from "./resman/reports/work-orders";
import { withLock } from "./shared/run-lock";

/**
 * Work orders are pulled from further back than the scheduled job's 01/01/2024.
 * The point of the exercise is the history that predates the merge, and a
 * default that starts after it would return almost nothing.
 */
const WORK_ORDER_START_DATE = "01/01/2015";

/** Page the write property's units once; both passes read from this. */
async function loadLiveUnits(supabase: ServiceClient, propertyId: string): Promise<LiveUnitIndex> {
  const ids = new Set<string>();
  const idByNumber = new Map<string, string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("resman_units")
      .select("resman_unit_id, number")
      .eq("resman_property_id", propertyId)
      .order("resman_unit_id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`read resman_units failed: ${error.message}`);
    const batch = (data ?? []) as unknown as Array<{ resman_unit_id: string; number: string }>;
    for (const u of batch) {
      ids.add(u.resman_unit_id);
      const key = (u.number ?? "").trim();
      if (key.length > 0 && !idByNumber.has(key)) idByNumber.set(key, u.resman_unit_id);
    }
    if (batch.length < pageSize) break;
  }
  return { ids, idByNumber };
}

interface UnitPass {
  fetched: number;
  mapped: number;
  alreadyPresent: number;
  toInsert: Array<Record<string, unknown>>;
  /** Archived units whose number is taken by a DIFFERENT live unit id. */
  numberCollisions: UnitNumberCollision[];
}

async function fetchArchivedUnits(
  service: ResManReportService,
  client: ResManClient,
  archivedId: string,
  writePropertyId: string,
  live: LiveUnitIndex,
  scrapedAt: string,
): Promise<UnitPass> {
  const endpoint = buildAllUnitsEndpoint(client.configuration);
  const context = await service.loadViewerContext(endpoint);
  const fields = buildAllUnitsForm(context, {
    propertyOrGroupId: archivedId,
    asOfDate: formatAsOfDate(new Date()),
  });
  const bytes = await service.exportCSV(endpoint, fields);

  const { rows } = decodeCsvRows(bytes);
  if (rows.length < 2) {
    return { fetched: 0, mapped: 0, alreadyPresent: 0, toInsert: [], numberCollisions: [] };
  }

  const headers = rows[0];
  const lookup = new CsvHeaderLookup(headers);
  const dataRows = rows.slice(1);

  const pass: UnitPass = {
    fetched: dataRows.length,
    mapped: 0,
    alreadyPresent: 0,
    toInsert: [],
    numberCollisions: [],
  };

  for (const row of dataRows) {
    const mapped = mapAllUnitsRow(lookup, row, {
      // Deliberately the archived id, so a mis-wired run writes something
      // obviously wrong rather than something plausibly wrong. The real value is
      // forced below.
      //
      // The mapper reads `PropertyID` from the CSV and falls back to this. As of
      // this report version there IS no PropertyID column — checked against the
      // 891 live rows, whose `raw` carries PropertyName and no id — so the
      // fallback is what actually lands. The override below does not depend on
      // that staying true.
      defaultPropertyId: archivedId,
      sourceUrl: endpoint.viewerUrl,
      scrapedAt,
    });
    if (!mapped) continue;
    pass.mapped += 1;

    // The whole point of the run: the row is filed under the property we use
    // now, not the archived one it was scraped from.
    mapped.resman_property_id = writePropertyId;
    mapped.raw = Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""]));
    mapped.synced_at = scrapedAt;

    const verdict = classifyUnitRow(
      { resman_unit_id: String(mapped.resman_unit_id), number: String(mapped.number ?? "") },
      live,
    );
    if (verdict.kind === "alreadyOurs") {
      // Same unit record, already ours. Leave the live row alone.
      pass.alreadyPresent += 1;
      continue;
    }
    if (verdict.collision) pass.numberCollisions.push(verdict.collision);
    pass.toInsert.push(mapped);
  }

  return pass;
}

interface WorkOrderPass {
  fetched: number;
  mapped: number;
  linkedUnits: number;
  rows: Array<Record<string, unknown>>;
  byStatus: Map<string, number>;
}

async function fetchArchivedWorkOrders(
  service: ResManReportService,
  client: ResManClient,
  archivedId: string,
  writePropertyId: string,
  unitIdByNumber: Map<string, string>,
  scrapedAt: string,
): Promise<WorkOrderPass> {
  const endpoint = buildWorkOrdersEndpoint(client.configuration);
  const context = await service.loadViewerContext(endpoint);
  const period = firstAccountingPeriod(context.html);
  const fields = buildWorkOrdersForm(context, {
    propertyOrGroupId: archivedId,
    startDate: WORK_ORDER_START_DATE,
    endDate: formatWorkOrderDate(new Date()),
    accountingPeriodId: period.id,
    accountingPeriodLabel: period.label,
  });
  const bytes = await service.exportCSV(endpoint, fields);

  const { rows } = decodeCsvRows(bytes);
  if (rows.length < 2) {
    return { fetched: 0, mapped: 0, linkedUnits: 0, rows: [], byStatus: new Map() };
  }

  const headers = rows[0];
  const lookup = new CsvHeaderLookup(headers);
  const dataRows = rows.slice(1);

  const pass: WorkOrderPass = {
    fetched: dataRows.length,
    mapped: 0,
    linkedUnits: 0,
    rows: [],
    byStatus: new Map(),
  };

  for (const row of dataRows) {
    // The unit index is the WRITE property's, so an archived work order links to
    // the unit we hold today by number — the one identifier that survived the
    // property split.
    const mapped = mapWorkOrderRow(lookup, row, { propertyId: writePropertyId, unitIdByNumber });
    if (!mapped) continue;
    pass.mapped += 1;
    if (mapped.resman_unit_id !== null) pass.linkedUnits += 1;
    mapped.raw = Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""]));
    mapped.synced_at = scrapedAt;
    const status = String(mapped.status ?? "").trim() || "(blank)";
    pass.byStatus.set(status, (pass.byStatus.get(status) ?? 0) + 1);
    pass.rows.push(mapped);
  }

  return pass;
}

async function main(): Promise<void> {
  const env = process.env;
  const apply = process.argv.includes("--apply");
  const withUnits = process.argv.includes("--with-units");

  const writePropertyId = env[ENV.RESMAN_PROPERTY_ID]?.trim();
  if (!writePropertyId) {
    throw new Error(`Missing required environment variable: ${ENV.RESMAN_PROPERTY_ID}`);
  }

  const archivedIds = (env.RESMAN_ARCHIVED_PROPERTY_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (archivedIds.length === 0) {
    throw new Error(
      "Missing required environment variable: RESMAN_ARCHIVED_PROPERTY_IDS " +
        "(comma-separated ResMan property ids to merge in)",
    );
  }
  if (archivedIds.includes(writePropertyId)) {
    throw new Error(
      `RESMAN_ARCHIVED_PROPERTY_IDS contains the write property ${writePropertyId} — ` +
        "that would re-scrape the live property as if it were archived.",
    );
  }

  const configuration = resManConfigurationFromEnv(env);
  const credentials = resManCredentialsFromEnv(env);
  const supabase = createServiceClient(env);
  const client = new ResManClient(configuration, {
    credentials,
    connectionsPerHost: undefined,
    log: (m) => console.log(m),
  });

  console.log(
    `[merge] ${apply ? "APPLY" : "DRY RUN (nothing will be written — pass --apply to write)"}`,
  );
  console.log(`[merge] write property: ${writePropertyId}`);
  console.log(`[merge] archived properties: ${archivedIds.join(", ")}`);
  console.log(
    withUnits
      ? "[merge] units: ENABLED (--with-units) — read the collision count before applying"
      : "[merge] units: skipped (default). Work orders link to the live units by number.",
  );

  await client.ensureAuthenticated(credentials);
  const service = ResManReportService.fromClient(client);

  // Read once, up front. Units inserted during the run are added to the index so
  // a later property's work orders can link to them.
  const live = await loadLiveUnits(supabase, writePropertyId);
  console.log(`[merge] live property holds ${live.ids.size} units`);

  const collisions: Array<{ property: string; number: string; archivedId: string; liveId: string }> = [];
  let totalUnitsInserted = 0;
  let totalWorkOrdersUpserted = 0;
  /** Statuses that put a ticket on the maintenance Open board rather than in history. */
  const OPEN_STATUSES = new Set(["not started", "in progress", "on hold", "assigned"]);
  const openByStatus = new Map<string, number>();

  for (const archivedId of archivedIds) {
    const scrapedAt = new Date().toISOString();
    console.log(`\n[merge] ---- ${archivedId} ----`);

    if (withUnits) {
      let unitPass: UnitPass;
      try {
        unitPass = await fetchArchivedUnits(service, client, archivedId, writePropertyId, live, scrapedAt);
      } catch (error) {
        console.error(
          `[merge] ${archivedId}: units report FAILED — ${error instanceof Error ? error.message : String(error)}`,
        );
        console.error(`[merge] ${archivedId}: skipping this property (work orders included)`);
        continue;
      }

      console.log(
        `[merge] units: fetched=${unitPass.fetched} mapped=${unitPass.mapped} ` +
          `alreadyOurs=${unitPass.alreadyPresent} toInsert=${unitPass.toInsert.length} ` +
          `numberCollisions=${unitPass.numberCollisions.length}`,
      );
      for (const c of unitPass.numberCollisions.slice(0, 10)) {
        console.log(`[merge]   COLLISION unit ${c.number}: archived ${c.archivedId} vs live ${c.liveId}`);
      }
      if (unitPass.numberCollisions.length > 10) {
        console.log(`[merge]   … and ${unitPass.numberCollisions.length - 10} more`);
      }
      for (const c of unitPass.numberCollisions) collisions.push({ property: archivedId, ...c });

      if (apply && unitPass.toInsert.length > 0) {
        const out = await upsertMirror(supabase, "resman_units", unitPass.toInsert, {
          conflictColumn: "resman_unit_id",
          // No deleteMissing — see the header.
        });
        totalUnitsInserted += out.upserted;
        console.log(`[merge] units: inserted=${out.upserted}`);
      }
      // Keep the index current so this property's work orders — and the next
      // property's — can link to units this pass just added.
      for (const row of unitPass.toInsert) {
        const id = String(row.resman_unit_id);
        const number = String(row.number ?? "").trim();
        live.ids.add(id);
        if (number.length > 0 && !live.idByNumber.has(number)) live.idByNumber.set(number, id);
      }
    }

    let woPass: WorkOrderPass;
    try {
      woPass = await fetchArchivedWorkOrders(
        service,
        client,
        archivedId,
        writePropertyId,
        live.idByNumber,
        scrapedAt,
      );
    } catch (error) {
      console.error(
        `[merge] ${archivedId}: work-orders report FAILED — ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const statuses = [...woPass.byStatus.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${s}=${n}`)
      .join(" ");
    console.log(
      `[merge] work orders: fetched=${woPass.fetched} mapped=${woPass.mapped} ` +
        `linkedToUnit=${woPass.linkedUnits} unlinked=${woPass.mapped - woPass.linkedUnits}`,
    );
    console.log(`[merge] work orders by status: ${statuses || "(none)"}`);
    for (const [status, n] of woPass.byStatus) {
      if (!OPEN_STATUSES.has(status.toLowerCase())) continue;
      openByStatus.set(status, (openByStatus.get(status) ?? 0) + n);
    }

    if (apply && woPass.rows.length > 0) {
      const out = await upsertMirror(supabase, "resman_work_orders", woPass.rows, {
        conflictColumn: "resman_work_order_id",
        // No deleteMissing — see the header.
      });
      totalWorkOrdersUpserted += out.upserted;
      console.log(`[merge] work orders: upserted=${out.upserted}`);
    }
  }

  console.log("\n[merge] ================ summary ================");
  if (apply) {
    if (withUnits) console.log(`[merge] units inserted:      ${totalUnitsInserted}`);
    console.log(`[merge] work orders written: ${totalWorkOrdersUpserted}`);
    console.log(
      "[merge] next: run src/run-unit-details.ts then src/run-lease-details.ts against " +
        `RESMAN_PROPERTY_ID=${writePropertyId} to deep-scrape leases, residents and ledgers.`,
    );
  } else {
    console.log("[merge] DRY RUN — nothing was written. Re-run with --apply to commit.");
  }
  const openTotal = [...openByStatus.values()].reduce((a, b) => a + b, 0);
  if (openTotal > 0) {
    const detail = [...openByStatus.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}=${n}`);
    console.log(
      `[merge] HEADS UP: ${openTotal} of these work orders are in a non-terminal status ` +
        `(${detail.join(" ")}) and will appear on the maintenance OPEN board, not in history. ` +
        "They are years old and belong to properties that no longer exist.",
    );
  }

  if (!withUnits) {
    console.log(
      "[merge] units were not touched. The archived properties hold the SAME physical units " +
        "under different ResMan ids, so importing them would duplicate every address — see " +
        "the header. Pass --with-units only if that has changed.",
    );
  } else if (collisions.length > 0) {
    console.log(
      `[merge] WARNING: ${collisions.length} unit-number collision(s). Each one is an archived ` +
        "unit whose number already belongs to a different live unit id — applying creates a " +
        "duplicate row on the map, in the tenants list, and in occupancy counts.",
    );
  } else {
    console.log("[merge] no unit-number collisions — archived units are distinct or already ours.");
  }
}

// One ResMan scraper at a time — the request ceiling is per process, and a
// scheduled run must not overlap this. See shared/run-lock.ts.
withLock("resman", "run-merge-archived-properties", main)
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("[run-merge-archived-properties] failed:", error);
    process.exit(1);
  });
