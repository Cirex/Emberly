const assert = require("node:assert/strict");
const test = require("node:test");
const { mock } = require("bun:test");

// Same bun:test mock.module harness as tests/manager-api.test.js — this suite
// runs in its own process (the package.json `test` script runs each file
// separately), so the process-global mocks cannot leak into other files.
const state = {
  /** What requireResmanApiKey answers. */
  auth: { ok: false, response: null },
  /** Scripted untyped Supabase client. */
  db: null,
};

mock.module("@/lib/resman-api-auth", () => ({
  requireResmanApiKey: async () => state.auth,
  isFieldDeviceRole: (role) => role === "security_manager",
}));

mock.module("@/lib/supabase/admin", () => ({
  createAdminClient: () => state.db,
  createUntypedAdminClient: () => state.db,
  getMissingSupabaseAdminEnvVars: () => [],
}));

const {
  PEOPLE_PII_AUDIT_ACTION,
  buildPeoplePiiAuditLog,
  comparePeopleIndexEntries,
  getPersonProfile,
  listPeopleIndex,
  peopleAuditActor,
  peopleIndexEntry,
  personProfileEmployment,
  personProfileResident,
  rentToIncomeRatio,
  totalMonthlyIncome,
  vehiclesByPerson,
  wantsPii,
} = require("../lib/manager-people");

const peopleRoute = require("../app/api/resman/manager/people/route.ts");
const profileRoute = require("../app/api/resman/manager/people/[id]/route.ts");

// --- shared fakes ---------------------------------------------------------

function tokenAuth(overrides = {}) {
  return {
    ok: true,
    kind: "token",
    subject: {
      tokenId: "token-1",
      kind: "api_resman",
      subjectType: "admin_user",
      subjectId: "admin-7",
      label: "Priya Manager",
      role: "staff",
      scopes: [],
      ...overrides,
    },
  };
}

function untouchableDb() {
  return {
    from() {
      throw new Error("Supabase must not be touched");
    },
  };
}

/**
 * Scripted untyped Supabase: each `from()` consumes the next script
 * ({ table, <action>: result }); every chain method records onto the
 * operation and returns the chain; awaiting the chain (or maybeSingle/single)
 * resolves the scripted result.
 */
function scriptedSupabase(scripts, operations = []) {
  return {
    from(table) {
      const script = scripts.shift();
      if (!script) throw new Error(`Unexpected Supabase table ${table}`);
      assert.equal(table, script.table);
      const start = (action, extra) => {
        const result = script[action];
        if (result === undefined) throw new Error(`No scripted ${action} for ${table}`);
        const operation = { table, action, filters: [], orderBy: [], ...extra };
        operations.push(operation);
        return chain(result, operation);
      };
      return {
        select: (columns) => start("select", { columns }),
        insert: (values) => start("insert", { values }),
      };
    },
  };
}

function chain(result, operation) {
  const q = {
    eq(column, value) {
      operation.filters.push([column, value]);
      return q;
    },
    order(column, options) {
      operation.orderBy.push([column, options]);
      return q;
    },
    limit(count) {
      operation.limit = count;
      return q;
    },
    range(from, to) {
      operation.range = [from, to];
      return q;
    },
    maybeSingle: async () => result,
    single: async () => result,
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return q;
}

function managerRequest(path) {
  return new Request(`https://emberly-web.test/api/resman/manager${path}`);
}

const PERSON_ID = "pl-100";
const personParams = { params: Promise.resolve({ id: PERSON_ID }) };

// --- pure helpers ---------------------------------------------------------

test("wantsPii accepts only an explicit 1/true", () => {
  const q = (s) => wantsPii(new URLSearchParams(s));
  assert.equal(q("includePii=1"), true);
  assert.equal(q("includePii=true"), true);
  assert.equal(q("includePii=TRUE"), true);
  assert.equal(q("includePii=0"), false);
  assert.equal(q("includePii=yes"), false);
  assert.equal(q(""), false);
});

test("vehiclesByPerson groups plates and drops blank ones", () => {
  const map = vehiclesByPerson([
    { resman_person_lease_id: "a", license_plate: "7REY220", license_plate_state: "TN" },
    { resman_person_lease_id: "a", license_plate: " 4KLM881 ", license_plate_state: " TN " },
    { resman_person_lease_id: "b", license_plate: "  ", license_plate_state: "TN" },
  ]);
  assert.deepEqual(map.get("a"), [
    { plate: "7REY220", state: "TN" },
    { plate: "4KLM881", state: "TN" },
  ]);
  assert.equal(map.get("b"), undefined);
});

test("peopleIndexEntry carries the searchable fields and NO PII", () => {
  const entry = peopleIndexEntry(
    {
      resman_person_lease_id: "pl-1",
      resman_person_id: "p-1",
      resman_lease_id: "l-1",
      first_name: "Carmen",
      last_name: "Reyes",
      email: "carmen@example.com",
      phone_numbers: ["(901) 555-0112", "  "],
      household_status: "Current",
      is_primary: true,
    },
    "0327",
    [{ plate: "7REY220", state: "TN" }],
  );
  assert.deepEqual(entry, {
    personLeaseId: "pl-1",
    personId: "p-1",
    leaseId: "l-1",
    unitNumber: "0327",
    firstName: "Carmen",
    lastName: "Reyes",
    isPrimary: true,
    householdStatus: "Current",
    phones: ["(901) 555-0112"],
    email: "carmen@example.com",
    vehicles: [{ plate: "7REY220", state: "TN" }],
  });
  for (const key of ["birthdate", "driversLicense", "driversLicenseState", "monthlyIncome"]) {
    assert.equal(key in entry, false, `${key} must never reach the cached index`);
  }
});

test("comparePeopleIndexEntries sorts by surname, then first name", () => {
  const e = (first, last) => ({ firstName: first, lastName: last, personLeaseId: `${first}${last}` });
  const sorted = [e("Diego", "Reyes"), e("Ana", "Chen"), e("Carmen", "Reyes")].sort(
    comparePeopleIndexEntries,
  );
  assert.deepEqual(
    sorted.map((x) => `${x.firstName} ${x.lastName}`),
    ["Ana Chen", "Carmen Reyes", "Diego Reyes"],
  );
});

test("totalMonthlyIncome sums salary plus other income, tolerating nulls", () => {
  assert.equal(totalMonthlyIncome([]), 0);
  assert.equal(totalMonthlyIncome([{ monthly_income: 4200, other_income: null }]), 4200);
  assert.equal(
    totalMonthlyIncome([
      { monthly_income: 4200, other_income: 300 },
      { monthly_income: null, other_income: 500 },
    ]),
    5000,
  );
});

test("rentToIncomeRatio: 4-decimal ratio, null instead of NaN/Infinity", () => {
  assert.equal(rentToIncomeRatio(1240, 4500), 0.2756);
  assert.equal(rentToIncomeRatio(1240, 0), null);
  assert.equal(rentToIncomeRatio(null, 4500), null);
  assert.equal(rentToIncomeRatio(0, 4500), null);
  assert.equal(rentToIncomeRatio(1240, -10), null);
});

test("personProfileResident omits PII keys entirely unless includePii", () => {
  const row = {
    resman_person_lease_id: "pl-1",
    resman_person_id: "p-1",
    resman_lease_id: "l-1",
    first_name: "Carmen",
    last_name: "Reyes",
    email: "carmen@example.com",
    phone_numbers: ["(901) 555-0112"],
    gender: "Female",
    birthdate: "1988-04-02",
    household_status: "Current",
    drivers_license: "D1234567",
    drivers_license_state: "TN",
    language: "en",
    identification: "SSN",
    is_primary: true,
  };
  const masked = personProfileResident(row, false);
  assert.equal("birthdate" in masked, false);
  assert.equal("driversLicense" in masked, false);
  assert.equal("driversLicenseState" in masked, false);
  assert.equal(masked.firstName, "Carmen");

  const revealed = personProfileResident(row, true);
  assert.equal(revealed.birthdate, "1988-04-02");
  assert.equal(revealed.driversLicense, "D1234567");
  assert.equal(revealed.driversLicenseState, "TN");
});

test("personProfileEmployment hides income unless includePii", () => {
  const row = {
    resman_employment_id: "emp-1",
    employer_name: "Baptist Memorial",
    position: "RN, night shift",
    phone: "(901) 555-0199",
    other_income_source: "",
    monthly_income: 4500,
    other_income: 0,
    start_date: "2022-01-04",
  };
  const masked = personProfileEmployment(row, false);
  assert.equal("monthlyIncome" in masked, false);
  assert.equal("otherIncome" in masked, false);
  assert.equal(masked.employerName, "Baptist Memorial");
  assert.equal(personProfileEmployment(row, true).monthlyIncome, 4500);
});

test("peopleAuditActor attributes the token label, id and role", () => {
  assert.deepEqual(peopleAuditActor(tokenAuth()), {
    adminUserId: "admin-7",
    adminRole: "staff",
    adminDisplayName: "Priya Manager",
  });
  assert.deepEqual(peopleAuditActor({ kind: "scanner" }), {
    adminUserId: "scanner",
    adminRole: "scanner",
    adminDisplayName: "scanner",
  });
});

test("buildPeoplePiiAuditLog records who asked, for whom, and which field", () => {
  const row = buildPeoplePiiAuditLog(
    { adminUserId: "admin-7", adminRole: "staff", adminDisplayName: "Priya Manager" },
    { personLeaseId: "pl-1", field: "birthdate", leaseId: "l-1", unitNumber: "0327" },
    "2026-07-21T12:00:00.000Z",
  );
  assert.deepEqual(row, {
    admin_user_id: "admin-7",
    admin_role: "staff",
    admin_display_name: "Priya Manager",
    action: PEOPLE_PII_AUDIT_ACTION,
    target_type: "resident",
    target_id: "pl-1",
    metadata: {
      field: "birthdate",
      lease_id: "l-1",
      unit_number: "0327",
      surface: "manager_app",
    },
    created_at: "2026-07-21T12:00:00.000Z",
  });
  assert.equal(
    buildPeoplePiiAuditLog({ adminUserId: "a", adminRole: "r", adminDisplayName: "n" }, {
      personLeaseId: "pl-1",
    }).metadata.field,
    "all",
  );
});

// --- service: index -------------------------------------------------------

function indexScripts() {
  return [
    {
      table: "resman_residents",
      select: {
        data: [
          {
            resman_person_lease_id: "pl-2",
            resman_person_id: "p-2",
            resman_lease_id: "l-1",
            first_name: "Diego",
            last_name: "Reyes",
            email: "",
            phone_numbers: ["(901) 555-0133"],
            household_status: "Occupant",
            is_primary: false,
          },
          {
            resman_person_lease_id: "pl-1",
            resman_person_id: "p-1",
            resman_lease_id: "l-1",
            first_name: "Carmen",
            last_name: "Reyes",
            email: "carmen@example.com",
            phone_numbers: ["(901) 555-0112"],
            household_status: "Current",
            is_primary: true,
          },
        ],
        error: null,
      },
    },
    {
      table: "resman_leases",
      select: { data: [{ resman_lease_id: "l-1", unit_number: "0327" }], error: null },
    },
    {
      table: "resman_lease_vehicles",
      select: {
        data: [
          { resman_person_lease_id: "pl-1", license_plate: "7REY220", license_plate_state: "TN" },
        ],
        error: null,
      },
    },
  ];
}

test("listPeopleIndex stitches unit numbers and plates, sorted by name", async () => {
  const operations = [];
  const people = await listPeopleIndex(scriptedSupabase(indexScripts(), operations));
  assert.deepEqual(
    people.map((p) => `${p.firstName} ${p.lastName}`),
    ["Carmen Reyes", "Diego Reyes"],
  );
  assert.equal(people[0].unitNumber, "0327");
  assert.deepEqual(people[0].vehicles, [{ plate: "7REY220", state: "TN" }]);
  assert.deepEqual(people[1].vehicles, []);
  // Every read is ranged — an unranged select would truncate at PostgREST's
  // 1000-row cap and silently shrink the search index.
  assert.deepEqual(
    operations.map((o) => o.range),
    [
      [0, 999],
      [0, 999],
      [0, 999],
    ],
  );
});

// --- service: profile -----------------------------------------------------

function profileScripts({ employment = [{ resman_employment_id: "emp-1", employer_name: "Baptist Memorial", position: "RN", phone: "", other_income_source: "", monthly_income: 4500, other_income: 0, start_date: null }] } = {}) {
  return [
    {
      table: "resman_residents",
      select: {
        data: {
          resman_person_lease_id: PERSON_ID,
          resman_person_id: "p-1",
          resman_lease_id: "l-1",
          first_name: "Carmen",
          last_name: "Reyes",
          email: "carmen@example.com",
          phone_numbers: ["(901) 555-0112"],
          gender: "Female",
          birthdate: "1988-04-02",
          household_status: "Current",
          drivers_license: "D1234567",
          drivers_license_state: "TN",
          language: "en",
          identification: "",
          is_primary: true,
        },
        error: null,
      },
    },
    {
      table: "resman_leases",
      select: {
        data: {
          resman_lease_id: "l-1",
          resman_unit_id: "u-1",
          unit_number: "0327",
          status: "Current",
          start_date: "2024-05-01",
          end_date: "2026-07-31",
          move_in_date: "2024-05-04",
          move_out_date: null,
          leasing_agent: "QH",
          resident_rent: 1240,
          market_rent: 1300,
          balance: 0,
        },
        error: null,
      },
    },
    {
      table: "resman_units",
      select: {
        data: {
          resman_unit_id: "u-1",
          number: "0327",
          classification: "Diamond",
          bedrooms: 2,
          times_late: 0,
        },
        error: null,
      },
    },
    {
      table: "resman_residents",
      select: {
        data: [
          { resman_person_lease_id: PERSON_ID, first_name: "Carmen", last_name: "Reyes", is_primary: true, household_status: "Current", phone_numbers: [], email: "" },
          { resman_person_lease_id: "pl-2", first_name: "Diego", last_name: "Reyes", is_primary: false, household_status: "Occupant", phone_numbers: ["(901) 555-0133"], email: "" },
        ],
        error: null,
      },
    },
    {
      table: "resman_lease_vehicles",
      select: {
        data: [
          {
            resman_vehicle_id: "v-1",
            make: "Honda",
            model: "Civic",
            year: "2019",
            color: "Silver",
            license_plate: "7REY220",
            license_plate_state: "TN",
            parking_spot: "B-14",
          },
        ],
        error: null,
      },
    },
    {
      table: "resman_lease_insurance",
      select: {
        data: [
          {
            resman_insurance_id: "ins-1",
            provider: "State Farm",
            policy_number: "XX4471",
            policy_type: "Renters",
            status: "Active",
            start_date: "2025-07-30",
            end_date: "2026-07-30",
            coverage_amount: 100000,
          },
        ],
        error: null,
      },
    },
    { table: "resman_lease_employment", select: { data: employment, error: null } },
    {
      table: "resman_lease_alternate_contacts",
      select: {
        data: [
          {
            resman_contact_id: "c-1",
            name: "Elena Vega",
            relationship: "Mother",
            phone: "(901) 555-0148",
            email: "elena.vega@example.com",
            is_emergency_contact: true,
          },
        ],
        error: null,
      },
    },
    { table: "resman_lease_addresses", select: { data: [], error: null } },
    {
      table: "resman_work_orders",
      select: {
        data: [
          {
            resman_work_order_id: "wo-1",
            number: "1044",
            title: "Disposal jammed",
            status: "Closed",
            priority: "Normal",
            category: "Plumbing",
            technician: "QH",
            date_reported: "2026-06-10",
            date_completed: "2026-06-12",
            callback_status: "none",
          },
        ],
        error: null,
      },
    },
  ];
}

test("getPersonProfile assembles the sheet and masks PII by default", async () => {
  const operations = [];
  const profile = await getPersonProfile(
    scriptedSupabase(profileScripts(), operations),
    PERSON_ID,
    false,
  );

  assert.equal(profile.resident.firstName, "Carmen");
  assert.equal("birthdate" in profile.resident, false);
  assert.equal("driversLicense" in profile.resident, false);
  assert.equal("monthlyIncome" in profile.employment[0], false);
  assert.equal(profile.piiIncluded, false);

  assert.equal(profile.lease.unitNumber, "0327");
  assert.equal(profile.lease.classification, "Diamond");
  assert.equal(profile.lease.timesLate, 0);
  assert.equal(profile.lease.residentRent, 1240);
  assert.equal(profile.lease.leasingAgent, "QH");

  // The subject is excluded from their own household list.
  assert.deepEqual(
    profile.household.map((h) => h.firstName),
    ["Diego"],
  );
  assert.equal(profile.vehicles[0].plate, "7REY220");
  assert.equal(profile.vehicles[0].parkingSpot, "B-14");
  assert.equal(profile.insurance[0].provider, "State Farm");
  assert.equal(profile.alternateContacts[0].isEmergencyContact, true);
  assert.equal(profile.workOrders[0].title, "Disposal jammed");

  // The decision-useful number is present even with income withheld.
  assert.equal(profile.rentToIncomeRatio, 0.2756);

  const workOrders = operations.find((o) => o.table === "resman_work_orders");
  assert.deepEqual(workOrders.filters, [["unit_number", "0327"]]);
  assert.deepEqual(workOrders.orderBy, [["date_reported", { ascending: false }]]);
  assert.equal(workOrders.limit, 10);
});

test("getPersonProfile returns the PII fields under includePii", async () => {
  const profile = await getPersonProfile(scriptedSupabase(profileScripts()), PERSON_ID, true);
  assert.equal(profile.resident.birthdate, "1988-04-02");
  assert.equal(profile.resident.driversLicense, "D1234567");
  assert.equal(profile.employment[0].monthlyIncome, 4500);
  assert.equal(profile.piiIncluded, true);
});

test("getPersonProfile ratio is null when no income is on file", async () => {
  const profile = await getPersonProfile(
    scriptedSupabase(profileScripts({ employment: [] })),
    PERSON_ID,
    false,
  );
  assert.equal(profile.rentToIncomeRatio, null);
});

test("getPersonProfile answers null for an unknown person", async () => {
  const profile = await getPersonProfile(
    scriptedSupabase([{ table: "resman_residents", select: { data: null, error: null } }]),
    "nope",
  );
  assert.equal(profile, null);
});

// --- routes ---------------------------------------------------------------

test("GET people: rejected auth is passed straight through", async () => {
  state.auth = { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  state.db = untouchableDb();
  const res = await peopleRoute.GET(managerRequest("/people"));
  assert.equal(res.status, 401);
});

test("GET people: scanners and field-device roles are forbidden", async () => {
  state.db = untouchableDb();

  state.auth = { ok: true, kind: "scanner" };
  assert.equal((await peopleRoute.GET(managerRequest("/people"))).status, 403);

  state.auth = tokenAuth({ role: "security_manager" });
  assert.equal((await peopleRoute.GET(managerRequest("/people"))).status, 403);

  state.auth = { ok: true, kind: "scanner" };
  assert.equal((await profileRoute.GET(managerRequest(`/people/${PERSON_ID}`), personParams)).status, 403);
});

test("GET people: the index envelope carries the PII-free rows", async () => {
  state.auth = tokenAuth();
  state.db = scriptedSupabase(indexScripts());
  const res = await peopleRoute.GET(managerRequest("/people"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.people.length, 2);
  assert.equal(body.data.people[0].unitNumber, "0327");
  assert.equal(JSON.stringify(body).includes("birthdate"), false);
});

test("GET people/[id]: default response omits PII and writes no audit row", async () => {
  state.auth = tokenAuth();
  const operations = [];
  state.db = scriptedSupabase(profileScripts(), operations);
  const res = await profileRoute.GET(managerRequest(`/people/${PERSON_ID}`), personParams);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal("birthdate" in body.data.profile.resident, false);
  assert.equal(body.data.profile.rentToIncomeRatio, 0.2756);
  assert.equal(
    operations.some((o) => o.table === "admin_audit_logs"),
    false,
  );
});

test("GET people/[id]?includePii=1 returns PII and audits who asked", async () => {
  state.auth = tokenAuth();
  const operations = [];
  const scripts = profileScripts();
  scripts.push({ table: "admin_audit_logs", insert: { error: null } });
  state.db = scriptedSupabase(scripts, operations);

  const res = await profileRoute.GET(
    managerRequest(`/people/${PERSON_ID}?includePii=1&field=birthdate`),
    personParams,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.profile.resident.birthdate, "1988-04-02");
  assert.equal(body.data.profile.employment[0].monthlyIncome, 4500);

  const audit = operations.find((o) => o.table === "admin_audit_logs");
  assert.ok(audit, "a PII reveal must write an admin_audit_logs row");
  assert.equal(audit.values.action, PEOPLE_PII_AUDIT_ACTION);
  assert.equal(audit.values.admin_user_id, "admin-7");
  assert.equal(audit.values.admin_display_name, "Priya Manager");
  assert.equal(audit.values.target_id, PERSON_ID);
  assert.equal(audit.values.metadata.field, "birthdate");
  assert.equal(audit.values.metadata.unit_number, "0327");
});

test("GET people/[id]: unknown person is a 404", async () => {
  state.auth = tokenAuth();
  state.db = scriptedSupabase([{ table: "resman_residents", select: { data: null, error: null } }]);
  const res = await profileRoute.GET(managerRequest("/people/nope"), {
    params: Promise.resolve({ id: "nope" }),
  });
  assert.equal(res.status, 404);
});
