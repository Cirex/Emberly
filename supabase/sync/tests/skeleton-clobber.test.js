const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  SKELETON_OBSERVED_COLUMNS,
  mapLease,
  withoutBalance,
  withoutUnobservedFields,
} = require("../src/resman/scrapers/leases");

const JOB = path.join(__dirname, "..", "src", "resman", "jobs", "unit-detail.ts");

/**
 * THE SKELETON MUST NOT OVERWRITE THE DEEP PASS.
 *
 * `scrapeUnit` writes a skeleton for every non-current, non-terminal lease
 * (Pending, Notice to Vacate, Under Eviction, Month to Month) from the unit's
 * lease-history table. That table carries status, term dates, move-out date,
 * rent and the resident's name — nothing else. mapLease filled the rest with
 * "" and null, and the upsert wrote those blanks over what the deep pass had
 * read from the resident page.
 *
 * Measured 2026-08-15 on 40 of the 45 application leases: leasing agent,
 * approval status and every date wiped. deep_synced_at said 02:51 UTC,
 * updated_at said 14:55 — the deep pass captured them, the unit pass erased
 * them six hours later. The damage was permanent, because leaseScrapeTier
 * returns "skip" for a Pending lease that already carries deep_synced_at, so
 * the deep pass never came back to repair it.
 *
 * Same shape as the balance bug and the term-date bug: a pass writing a column
 * it cannot observe.
 */

/** Exactly what scrapeUnit's skeleton branch produces. */
const skeletonDict = () => ({
  leaseId: "L1",
  status: "Pending",
  residents: [{ personLeaseId: "L1", fullName: "Danarah Beard", isPrimary: true }],
  leaseStartDate: "9/18/2026",
  leaseEndDate: "9/17/2027",
  _skeleton: true,
});

const ctx = { unitId: "U1", unitNumber: "3588 KG-3", propertyId: "P1", isMostRecent: false };

test("the raw skeleton row DOES carry blanks — this is what had to be stripped", () => {
  const row = mapLease(skeletonDict(), ctx);
  assert.equal(row.leasing_agent, "", "proof the blanks are real");
  assert.equal(row.approval_status, "");
  assert.equal(row.application_date, null);
});

test("stripping removes every column the lease-history table cannot see", () => {
  const stripped = withoutUnobservedFields(withoutBalance(mapLease(skeletonDict(), ctx)));
  for (const column of [
    "leasing_agent",
    "approval_status",
    "approved_date",
    "approved_by",
    "application_date",
    "signed_date",
    "move_in_date",
    "market_rent",
    "original_start_date",
    "lease_sent_date",
  ]) {
    assert.equal(column in stripped, false, `${column} must be ABSENT, not null`);
  }
});

test("…and keeps everything it genuinely observed", () => {
  const stripped = withoutUnobservedFields(withoutBalance(mapLease(skeletonDict(), ctx)));
  assert.equal(stripped.resman_lease_id, "L1");
  assert.equal(stripped.status, "Pending");
  assert.equal(stripped.start_date, "2026-09-18");
  assert.equal(stripped.end_date, "2027-09-17");
  assert.equal(stripped.unit_number, "3588 KG-3");
});

test("nothing survives the strip that is not on the observed list", () => {
  // The guard: if mapLease grows a new column, it lands in the skeleton row
  // and silently clobbers again unless it is added to one list or the other.
  const stripped = withoutUnobservedFields(withoutBalance(mapLease(skeletonDict(), ctx)));
  const allowed = new Set([...SKELETON_OBSERVED_COLUMNS, "deep_synced_at", "synced_at"]);
  const unexpected = Object.keys(stripped).filter((k) => !allowed.has(k));
  assert.deepEqual(
    unexpected,
    [],
    `new column(s) reaching the skeleton write: add to SKELETON_UNOBSERVED_COLUMNS or SKELETON_OBSERVED_COLUMNS`,
  );
});

test("absent keys, never nulls — an absent key leaves the column alone on upsert", () => {
  const stripped = withoutUnobservedFields(withoutBalance(mapLease(skeletonDict(), ctx)));
  for (const [key, value] of Object.entries(stripped)) {
    if (SKELETON_OBSERVED_COLUMNS.includes(key)) continue;
    assert.notEqual(value, null, `${key} is present AND null — that overwrites`);
  }
});

// ── the job has to keep the two batches apart ───────────────────────────────

function jobBody(name) {
  const source = fs.readFileSync(JOB, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start > 0, `${name} not found`);
  const after = source.slice(start + 1);
  const next = after.indexOf("\nexport async function ");
  return next === -1 ? after : after.slice(0, next);
}

test("skeletons are routed to their own upsert batch", () => {
  // PostgREST builds ONE statement from the union of keys in a batch, so a
  // stripped row mixed in with full ones puts the blanks back for the whole
  // chunk. The strip only works if the batches stay separate.
  const body = jobBody("syncUnitDetails");
  assert.match(body, /_skeleton === true/);
  assert.match(body, /skeletonRows\.push\(withoutUnobservedFields\(withoutBalance\(leaseRow\)\)\)/);
  assert.match(body, /upsertMirror\(supabase, "resman_leases", skeletonRows/);
});

test("the scraper still marks its skeletons", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "resman", "scrapers", "unit-detail.ts"),
    "utf8",
  );
  assert.match(source, /_skeleton: true/);
});
