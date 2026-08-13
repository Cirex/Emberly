const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const RULES = path.join(SRC, "resman", "merge-archived.ts");
const RUNNER = path.join(SRC, "run-merge-archived-leases.ts");

/**
 * Bringing the archived properties' leases over, where the LIVE property is
 * authoritative: a lease that exists on both sides is dropped, and only archived
 * leases with no live counterpart come over as history.
 *
 * No id survived the property merge — ResMan re-minted properties, units, leases
 * AND persons (Mario Shannon is 90ed6fde… archived, fb1c4254… live, zero
 * overlap). Unit numbers, dates and human names are all that carried across, so
 * they are the whole basis of the match.
 */

const index = (entries) => {
  const byTermAndResidents = new Map();
  const byTerm = new Map();
  for (const [term, residents, id] of entries) {
    byTerm.set(term, [...(byTerm.get(term) ?? []), id]);
    if (residents) byTermAndResidents.set(`${term}|${residents}`, id);
  }
  return { byTermAndResidents, byTerm };
};

test("normalizeName flattens case and whitespace", async () => {
  const { normalizeName } = await import(RULES);
  assert.equal(normalizeName("  Mario   SHANNON "), "mario shannon");
  assert.equal(normalizeName(null), "");
});

test("residentKey is a sorted set, so order and duplicates cannot change it", async () => {
  const { residentKey } = await import(RULES);
  // One archived lease listed "Paris Hurt" twice under two person ids; a
  // count-sensitive key would read that as a different household.
  assert.equal(residentKey(["Paris Hurt", "Paris Hurt", "Mill Medlock"]), "mill medlock+paris hurt");
  assert.equal(residentKey(["Mill Medlock", "Paris Hurt"]), "mill medlock+paris hurt");
  assert.equal(residentKey([" ", null, undefined]), "");
});

test("a lease matching term and household is skipped — the live row wins", async () => {
  const { classifyArchivedLease } = await import(RULES);
  const live = index([["1709 CW-1|2025-02-27|2026-02-26", "mario shannon", "live-1"]]);
  const v = classifyArchivedLease(
    {
      unitNumber: "1709 CW-1",
      startDate: "2025-02-27",
      endDate: "2026-02-26",
      residentNames: ["Mario Shannon"],
    },
    live,
    true,
  );
  assert.deepEqual(v, { kind: "skip", reason: "resident-and-term", liveLeaseId: "live-1" });
});

test("a skeleton lease with no residents still skips on term alone", async () => {
  const { classifyArchivedLease } = await import(RULES);
  // Past and pending leases come back from the lease-history table with no
  // resident identity. Without this tier every one would import as a duplicate.
  const live = index([["1783 NG-1|2026-02-23|2027-02-18", "darreka pride", "live-2"]]);
  const v = classifyArchivedLease(
    { unitNumber: "1783 NG-1", startDate: "2026-02-23", endDate: "2027-02-18", residentNames: [] },
    live,
    true,
  );
  assert.deepEqual(v, { kind: "skip", reason: "term-only", liveLeaseId: "live-2" });
});

test("a different household on the same term still skips, and says so", async () => {
  const { classifyArchivedLease } = await import(RULES);
  // Deliberately conservative: the tier is reported separately so the weaker
  // match stays visible in the dry run rather than hiding inside a total.
  const live = index([["1783 NG-1|2026-02-23|2027-02-18", "darreka pride", "live-2"]]);
  const v = classifyArchivedLease(
    {
      unitNumber: "1783 NG-1",
      startDate: "2026-02-23",
      endDate: "2027-02-18",
      residentNames: ["Someone Else"],
    },
    live,
    true,
  );
  assert.equal(v.kind, "skip");
  assert.equal(v.reason, "term-only");
});

test("a genuinely old lease with no live counterpart is imported", async () => {
  const { classifyArchivedLease } = await import(RULES);
  const live = index([["1709 CW-1|2025-02-27|2026-02-26", "mario shannon", "live-1"]]);
  const v = classifyArchivedLease(
    {
      unitNumber: "1709 CW-1",
      startDate: "2023-01-01",
      endDate: "2023-12-31",
      residentNames: ["Older Resident"],
    },
    live,
    true,
  );
  assert.deepEqual(v, { kind: "import" });
});

test("no live unit with that number means there is nothing to attach to", async () => {
  const { classifyArchivedLease } = await import(RULES);
  const v = classifyArchivedLease(
    { unitNumber: "GONE-1", startDate: "2023-01-01", endDate: "2023-12-31", residentNames: [] },
    index([]),
    false,
  );
  assert.deepEqual(v, { kind: "noLiveUnit" });
});

test("a lease with no term is never imported on a guess", async () => {
  const { classifyArchivedLease } = await import(RULES);
  const v = classifyArchivedLease(
    { unitNumber: "1709 CW-1", startDate: null, endDate: null, residentNames: ["Mario Shannon"] },
    index([]),
    true,
  );
  assert.deepEqual(v, { kind: "unkeyable" });
});

test("imported leases are flagged as history, never current or most-recent", () => {
  const source = fs.readFileSync(RUNNER, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  // syncLeaseDetails selects on `is_current_lease OR is_most_recent_lease` scoped
  // to the live property. Either flag left set would hand an archived lease id to
  // the nightly job, which would scrape it against a property it does not exist in.
  assert.match(source, /isMostRecent:\s*false/);
  assert.match(source, /leaseRow\.is_current_lease = false/);
  assert.match(source, /leaseRow\.is_most_recent_lease = false/);
});

test("dates are normalised before keying, on both sides", () => {
  const source = fs.readFileSync(RUNNER, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  // ResMan returns ISO for the lease term but M/D/YYYY elsewhere in the same
  // payload. Comparing a raw scrape value against the DB's date column would make
  // every lease look new and import a duplicate of all 891 doors' history.
  assert.match(source, /startDate:\s*parseLedgerDate\(/);
  assert.match(source, /endDate:\s*parseLedgerDate\(/);
});

test("no delete-missing, and every write is behind --apply", () => {
  const source = fs.readFileSync(RUNNER, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.doesNotMatch(source, /deleteMissing|deleteScope/);
  assert.match(source, /const apply = argv\.includes\("--apply"\)/);
  assert.match(source, /if \(apply && leaseRows\.length > 0\)/);
});

test("units are not written by this runner", () => {
  const source = fs.readFileSync(RUNNER, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  // The archived properties hold the same 891 doors under different GUIDs.
  assert.doesNotMatch(source, /upsertMirror\([^,]+,\s*"resman_units"/);
});
