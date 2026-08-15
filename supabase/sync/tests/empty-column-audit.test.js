const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  monthlyFromPeriod,
  parseEmploymentTab,
  parseVehiclesTab,
} = require("../src/resman/scrapers/unit-detail");
const { mapEmploymentRows, mapVehicleRows } = require("../src/resman/scrapers/residents");

const SCHEMA = path.join(__dirname, "..", "..", "..", "apps", "web", "lib", "supabase", "schema.sql");
const UNIT_DETAIL_JOB = path.join(__dirname, "..", "src", "resman", "jobs", "unit-detail.ts");

/**
 * Every mirrored column was checked for the balance signature — 100% empty
 * across the whole table — and each hit was then triaged against the LIVE page
 * rather than assumed, because the balance bug taught us that a column can look
 * perfectly readable and simply not be there.
 *
 * Fixable (the data was on the page and being thrown away):
 *
 *   resman_units.resman_floorplan_id / pets_permitted / affordable_unit /
 *   country      the unit page carries all four ("Pets permitted: 2",
 *                "Affordable unit: No", the UnitTypes/Detail UUID, and the
 *                address block's third line). scrapeUnit parsed them every run;
 *                syncUnitDetails then dropped them because unit rows were
 *                considered the roster job's business — and the roster CSV and
 *                unit-info report carry none of the four. 0 of 891 units.
 *   resman_lease_vehicles.permit_number / notes
 *                new columns. See below.
 *   resman_lease_employment.other_income_source
 *                0 of 1,113 — mapped from a "Source" key no parser emits.
 *
 * Not fixable — ResMan does not have the field (verified column-by-column
 * against the live tabs, headers quoted in schema.sql):
 *
 *   resman_lease_vehicles.parking_spot     no parking-space column exists
 *   resman_lease_insurance.start_date      expiration date only
 *   resman_lease_addresses.start/end_date  the tab records no dates
 *   resman_work_orders.unit_lease_group_id / resman_lease_id
 *                                          no lease link in the report
 *
 * Not a scrape at all — engines that were never built: work_orders.tags
 * (WorkOrderTagging), is_duplicate, and the callback_* set.
 */

// ── resman_units: four columns nothing was writing ──────────────────────────

/** Body of one exported function in the job file — the two jobs live side by side. */
function jobBody(name) {
  const source = fs.readFileSync(UNIT_DETAIL_JOB, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start > 0, `${name} not found`);
  const after = source.slice(start + 1);
  const next = after.indexOf("\nexport async function ");
  return next === -1 ? after : after.slice(0, next);
}

test("the unit-details job writes the four unit columns only its scrape can see", () => {
  const body = jobBody("syncUnitDetails");
  assert.match(body, /unitRows\.push\(\{/);
  for (const column of ["resman_floorplan_id", "pets_permitted", "affordable_unit", "country"]) {
    assert.match(body, new RegExp(`${column}:`), `${column} must be written`);
  }
  assert.match(body, /upsertMirror\(supabase, "resman_units", unitRows/);
});

test("the enrichment row carries every NOT NULL column that has no default", () => {
  // `upsert` is INSERT ... ON CONFLICT DO UPDATE, and Postgres builds the
  // insert tuple BEFORE resolving the conflict. So a partial-column upsert
  // against rows that all already exist still has to satisfy every NOT NULL
  // constraint that has no default — omitting resman_property_id failed all
  // 391 rows of a chunk and aborted the run after 891 clean scrapes.
  const required = [];
  const table = /create table if not exists public\.resman_units \(([\s\S]*?)\n\);/.exec(
    fs.readFileSync(SCHEMA, "utf8"),
  );
  assert.ok(table, "resman_units must be in schema.sql");
  for (const line of table[1].split("\n")) {
    const column = /^\s*(\w+)\s+[\w()]+.*\bnot null\b/.exec(line);
    if (column && !/\bdefault\b/.test(line)) required.push(column[1]);
  }
  assert.ok(required.length > 0, "the scan must actually find constraints");

  const literal = /unitRows\.push\(\{([\s\S]*?)\}\);/.exec(jobBody("syncUnitDetails"));
  assert.ok(literal);
  for (const column of required) {
    assert.match(literal[1], new RegExp(`\\b${column}:`), `${column} is NOT NULL with no default`);
  }
});

test("the unit upsert never deletes — the roster job owns which units exist", () => {
  // This pass sees only the units it managed to scrape. A delete-missing here
  // would remove every unit a partial run skipped.
  const body = jobBody("syncUnitDetails");
  const call = /upsertMirror\(supabase, "resman_units", unitRows, \{([^}]*)\}/.exec(body);
  assert.ok(call, "the resman_units upsert must be present");
  assert.doesNotMatch(call[1], /deleteMissing/);
});

test("all four keys are always present, even as null", () => {
  // PostgREST builds ONE statement from the union of keys in a batch, so a key
  // that appears on only some rows resets the column to its default on the
  // rest. Writing null is safe only because this pass is the sole writer —
  // which is exactly the invariant the balance bug violated.
  const body = jobBody("syncUnitDetails");
  const literal = /unitRows\.push\(\{([\s\S]*?)\}\);/.exec(body);
  assert.ok(literal, "the unit row literal must be a literal, not a conditional build-up");
  assert.doesNotMatch(literal[1], /\bif\b|\?\?=|delete /);
});

// ── Vehicles: a permit number, not a parking spot ───────────────────────────

const VEHICLE_ROW = `
  <tr>
    <td class="a-year-col"><div class="fl">Year</div><div class="fv">2019</div></td>
    <td class="a-make-model-col"><div class="fl">Make - Model</div><div class="fv"><div class="oe-tip">Jeep Cherokee</div></div></td>
    <td class="a-color-col"><div class="fl">Color</div><div class="fv"><div class="oe-tip">Black</div></div></td>
    <td class="a-license-plate-col"><div class="fl">License plate</div><div class="fv"><div class="oe-tip"> QTY68SD / TN </div></div></td>
    <td class="a-permit-col"><div class="fl">Permit number</div><div class="fv"><div class="oe-tip">0625</div></div></td>
  </tr>
  <tr>
    <td colspan="6" class="a-notes-col"><div class="fl"><label for="Automobiles_0__Notes">Notes</label></div><div class="fv break-long-words">P/U decal 04/16/2025Update 0625</div></td>
  </tr>`;

test("the permit (decal) number is read off the Vehicles tab", () => {
  const [vehicle] = parseVehiclesTab(VEHICLE_ROW);
  assert.equal(vehicle["Permit Number"], "0625");
  assert.equal(vehicle.Notes, "P/U decal 04/16/2025Update 0625");
});

test("permit number and notes reach the row; parking_spot is not invented", () => {
  const [row] = mapVehicleRows(parseVehiclesTab(VEHICLE_ROW), "PL1");
  assert.equal(row.permit_number, "0625");
  assert.equal(row.notes, "P/U decal 04/16/2025Update 0625");
  // The tab has no parking-space field. Writing the decal number into a column
  // called `parking_spot` would put real data under a wrong name, which is
  // worse than leaving it empty.
  assert.ok(!("parking_spot" in row), "parking_spot must not be fabricated from the permit");
});

test("a vehicle with no permit yields an empty string, not undefined", () => {
  const bare = VEHICLE_ROW.replace(/<td class="a-permit-col">[\s\S]*?<\/td>/, "");
  const [row] = mapVehicleRows(parseVehiclesTab(bare), "PL1");
  assert.equal(row.permit_number, "", "the column is NOT NULL default ''");
});

// ── Employment: the Industry cell is the discriminator ──────────────────────

const EMPLOYMENT_TAB = (industry, employer, title, salary) => `
  <tr><th class="e-industry-col">Industry</th><th class="e-employer-col">Employer / Type</th><th class="e-title-col">Title</th><th class="e-salary-col">Salary / Amount</th></tr>
  <tr id="employment0" class="employment" data-item-id="x"><td>${industry}</td><td>${employer}</td><td>${title}</td><td class="e-salary-col"> ${salary} </td></tr>
  <tr for="employment0" class="detail-row"><td colspan="5"><table class="detail-table employment-contact"><tr>
    <td class="e-start-date-col"><div class="fl">Start date</div><div class="fv name">1/26/2025</div></td>
    <td class="e-phone-col"><div class="fl">Phone number</div><div class="fv phone">(901) 453-5971</div></td>
  </tr></table></td></tr>`;

test("an OTHER-INCOME record names its source and files the amount as other income", () => {
  // Industry reads literally "Other Income"; the Employer/Type cell then holds
  // the source. This is the only thing separating the two record kinds that
  // share the one "Employment & Other Income" tab.
  const [row] = parseEmploymentTab(EMPLOYMENT_TAB("Other Income", "Business", "", "$20,000.00 (Annually)"));
  assert.equal(row["Other Income Source"], "Business");
  assert.equal(row["Other Income"], 20000 / 12);
  assert.equal(row["Income"], undefined, "an other-income record is not a salary");

  const [mapped] = mapEmploymentRows([row], "PL1");
  assert.equal(mapped.other_income_source, "Business");
  assert.equal(mapped.monthly_income, null);
});

test("an ordinary job leaves other_income_source empty — the Employer cell already holds it", () => {
  const [row] = parseEmploymentTab(EMPLOYMENT_TAB("", "Gold Strike", "House Keeper", "$1,500.00 (Biweekly)"));
  const [mapped] = mapEmploymentRows([row], "PL1");
  assert.equal(mapped.employer_name, "Gold Strike");
  assert.equal(mapped.other_income_source, "");
  assert.equal(mapped.other_income, null);
});

test("a biweekly job is a JOB, not other income", () => {
  // The old rule was "anything not marked (Monthly) is other income", so this
  // resident's $1,500 paycheque was recorded as $1,500 of other income and
  // their monthly_income was left null. Both figures were wrong.
  const [row] = parseEmploymentTab(EMPLOYMENT_TAB("", "Gold Strike", "House Keeper", "$1,500.00 (Biweekly)"));
  assert.equal(row["Other Income"], undefined);
  assert.equal(row["Income"], (1500 * 26) / 12);
});

test("an annual salary is converted, not filed as other income", () => {
  // The real row that exposed this: a $51,474/yr aircraft mechanic, recorded as
  // $51,474 of "other income" — off by 12× in the affordability math.
  const [row] = parseEmploymentTab(EMPLOYMENT_TAB("", "honeywell", "Aircraft mechanic tech 2", "$51,474.00 (Annually)"));
  assert.equal(row["Income"], 51474 / 12);
  assert.equal(row["Other Income"], undefined);
});

test("every pay period the tab uses converts to a monthly figure", () => {
  assert.equal(monthlyFromPeriod(2100, "$2,100.00 (Monthly)"), 2100);
  assert.equal(monthlyFromPeriod(24000, "$24,000.00 (Annually)"), 2000);
  assert.equal(monthlyFromPeriod(24000, "$24,000.00 (Yearly)"), 2000);
  assert.equal(monthlyFromPeriod(1000, "$1,000.00 (Semimonthly)"), 2000);
  assert.equal(monthlyFromPeriod(1200, "$1,200.00 (Biweekly)"), (1200 * 26) / 12);
  assert.equal(monthlyFromPeriod(600, "$600.00 (Weekly)"), (600 * 52) / 12);
});

test("biweekly is 26 pay periods a year, not 24 — the difference is real money", () => {
  // Two extra cheques a year. Treating biweekly as semimonthly understates a
  // $1,200 cheque by $200/month, which is the difference between qualifying
  // and not on a 3× rent rule.
  assert.notEqual(monthlyFromPeriod(1200, "(Biweekly)"), monthlyFromPeriod(1200, "(Semimonthly)"));
  assert.equal(Math.round(monthlyFromPeriod(1200, "(Biweekly)")), 2600);
  assert.equal(monthlyFromPeriod(1200, "(Semimonthly)"), 2400);
});

test("an hourly rate yields NULL rather than a guessed 40-hour week", () => {
  // The page records no hours anywhere. A guess would read downstream as a
  // measured figure; null reads as what it is.
  assert.equal(monthlyFromPeriod(18.5, "$18.50 (Hourly)"), null);
  const [row] = parseEmploymentTab(EMPLOYMENT_TAB("", "Kroger", "Cashier", "$18.50 (Hourly)"));
  assert.equal(row["Income"], undefined);
  assert.equal(row["Other Income"], undefined);
  assert.equal(row.Employer, "Kroger", "the rest of the record still lands");
});

test("no period at all is taken as monthly — ResMan's own default", () => {
  assert.equal(monthlyFromPeriod(1500, "$1,500.00"), 1500);
});

// ── The columns that cannot be filled stay documented as such ───────────────

test("schema.sql records WHY each unfillable column is empty", () => {
  // Without this the next audit re-opens the same four investigations, and the
  // temptation is to "fix" them by writing something plausible.
  const sql = fs.readFileSync(SCHEMA, "utf8");
  for (const [column, needle] of [
    ["parking_spot", /parking_spot[^\n]*always empty[^\n]*no parking-space field/],
    ["insurance.start_date", /start_date[^\n]*always empty[^\n]*Insurance tab/],
    ["addresses.start_date", /start_date[^\n]*always empty[^\n]*Addresses tab/],
    ["work order lease link", /resman_lease_id[^\n]*always empty[^\n]*no lease link/],
  ]) {
    assert.match(sql, needle, `${column} must carry its note`);
  }
});
