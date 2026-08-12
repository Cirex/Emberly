const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const LEASES = path.join(SRC, "resman", "scrapers", "leases.ts");
const UNIT_DETAIL_JOB = path.join(SRC, "resman", "jobs", "unit-detail.ts");
const UNIT_DETAIL_SCRAPER = path.join(SRC, "resman", "scrapers", "unit-detail.ts");

/**
 * A lease's TERM (start_date / end_date) comes from the unit's lease-history
 * table, never from the lease detail page.
 *
 * `syncLeaseDetails` reads the detail page. To reuse the shared scraper it feeds
 * `mapLease` a synthetic history row with both dates null — "I did not look",
 * which `mapLease` cannot distinguish from "there is no term". It emitted nulls,
 * the upsert wrote them over real dates, and the now-terminal, now-deep-synced
 * lease qualified for the archived-lease skip in `loadArchivedLeaseIds`. From
 * then on `unit-details` skipped it and the nulls were permanent.
 *
 * Measured 2026-08-11: 192 of 1,242 leases stuck that way, all terminal, all
 * deep-synced by the lease-details pass.
 */

test("withoutTermDates drops exactly start_date and end_date", async () => {
  const { withoutTermDates } = await import(LEASES);
  const row = {
    resman_lease_id: "L1",
    start_date: "2025-02-27",
    end_date: "2026-02-26",
    move_in_date: "2025-02-27",
    move_out_date: "2026-02-25",
    application_date: "2025-01-04",
    signed_date: "2025-02-01",
    status: "Former",
  };
  const out = withoutTermDates(row);
  assert.ok(!("start_date" in out), "start_date must be absent, not null");
  assert.ok(!("end_date" in out), "end_date must be absent, not null");
  // Everything the detail page DOES observe has to survive. Measured against
  // the damaged rows: move_out_date present on 189/192, move_in_date on 192/192.
  assert.equal(out.move_in_date, "2025-02-27");
  assert.equal(out.move_out_date, "2026-02-25");
  assert.equal(out.application_date, "2025-01-04");
  assert.equal(out.signed_date, "2025-02-01");
  assert.equal(out.status, "Former");
  assert.equal(out.resman_lease_id, "L1");
});

test("withoutTermDates omits the keys rather than nulling them", async () => {
  const { withoutTermDates } = await import(LEASES);
  // An absent key leaves the column alone on upsert; a null key overwrites it.
  // That difference is the entire bug.
  const out = withoutTermDates({ resman_lease_id: "L1", start_date: null, end_date: null });
  assert.deepEqual(Object.keys(out), ["resman_lease_id"]);
});

/** Body of one exported function in the job file — the two jobs live side by side. */
function jobBody(name) {
  const source = fs.readFileSync(UNIT_DETAIL_JOB, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start > 0, `${name} not found`);
  const after = source.slice(start + 1);
  const next = after.indexOf("\nexport async function ");
  return next === -1 ? after : after.slice(0, next);
}

test("the lease-details job strips term dates from every row it writes", () => {
  const body = jobBody("syncLeaseDetails");
  // PostgREST builds one statement from the union of keys in a batch, so a
  // single unstripped row would put the nulls back for the whole batch.
  assert.match(body, /leaseRows\.push\(withoutTermDates\(leaseRow\)\)/);
  assert.doesNotMatch(
    body,
    /leaseRows\.push\(\s*leaseRow,?\s*\)/,
    "a raw leaseRow push here would reintroduce null term dates",
  );
});

test("the unit-details job still writes term dates — it reads the history table", () => {
  // The opposite requirement, in the same file. unit-details is the ONLY source
  // of the lease term, and stripping there would mean nothing ever writes it.
  const body = jobBody("syncUnitDetails");
  assert.match(body, /leaseRows\.push\(leaseRow\)/);
  assert.doesNotMatch(body, /withoutTermDates/);
});

test("the synthetic history row still declares null dates — the reason the strip exists", () => {
  // If this ever stops being synthetic, the strip can go. Until then it is the
  // source of the nulls and worth pinning so the two cannot drift apart.
  const source = fs.readFileSync(UNIT_DETAIL_SCRAPER, "utf8");
  const fn = source.slice(source.indexOf("export async function scrapeLeaseByPersonLeaseId"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /leaseStartDate:\s*null/);
  assert.match(body, /leaseEndDate:\s*null/);
});

test("mapLease itself still maps term dates — unit-details depends on it", async () => {
  const { mapLease } = await import(LEASES);
  // The unit-details path feeds REAL history rows and must keep writing dates;
  // the fix belongs at the lease-details write, not in the shared mapper.
  const row = mapLease(
    { leaseId: "L1", status: "Former", leaseStartDate: "2/27/2025", leaseEndDate: "2/26/2026" },
    { unitId: "U1", unitNumber: "1709 CW-1", propertyId: "P1", isMostRecent: true },
  );
  assert.equal(row.start_date, "2025-02-27");
  assert.equal(row.end_date, "2026-02-26");
});
