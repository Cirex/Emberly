const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isApplicationLeaseStatus,
  parseActivityLog,
} = require("../src/resman/scrapers/unit-detail");

/** The approval half of the log, kept in the shape the old tests asserted. */
const parseActivityLogApproval = (html) => {
  const f = parseActivityLog(html);
  return f.approvedDate === null ? null : { date: f.approvedDate, by: f.approvedBy };
};
const { mapLease } = require("../src/resman/scrapers/leases");

/**
 * WHERE THE APPROVAL DATE COMES FROM.
 *
 * ResMan has no approval-date field. The resident page carries "Approval
 * status" — a bare "Approved" or "Denied" with nothing beside it — and the
 * Applications and Screening Results tabs come back empty on this property.
 * The only record of WHEN is a line in the Activity Log:
 *
 *   8/14/2026 11:25:33 AM | Resident(s) Ariauna Williams approved for move in
 *                           to unit 3714 DU-2 | Natalie Pointer
 *
 * Sampled across approved leases the wording was identical every time, and an
 * application not yet approved had no such line at all.
 */

/** The tab's real markup: timestamp cell, activity cell, user cell. */
const row = (timestamp, activity, user) =>
  `<tr><td class="l-date-col top">${timestamp}</td><td class="top">${activity} </td>` +
  `<td class="l-user-col top"><div class="oe-tip l-user-col">${user} </div></td></tr>`;

const HEADER = `<tr><th class="l-date-col">Timestamp</th><th>Activity</th><th class="l-date-col">User</th></tr>`;

test("reads the date and the approver off the approval line", () => {
  const html =
    HEADER +
    row("8/13/2026 2:08:40 PM", "Resident(s) Mamadou Saliou Diallo set for transfer from unit 3712 EG-4 to unit 1x1 Ruby", "Nicias Teal") +
    row("7/7/2026 9:46:17 AM", "Resident(s) mamadou saliou diallo approved for move in to unit 3712 EG-4", "Nicole Jones");
  assert.deepEqual(parseActivityLogApproval(html), { date: "2026-07-07", by: "Nicole Jones" });
});

test("an application with no approval line yields null, not a guess", () => {
  const html = HEADER + row("8/13/2026 9:00:00 AM", "Resident document uploaded", "Nicias Teal");
  assert.equal(parseActivityLogApproval(html), null);
});

test("only the move-in approval counts, not every line mentioning approval", () => {
  // A bare /approv/ would catch these and date the approval wrongly.
  const html =
    HEADER +
    row("8/1/2026 10:00:00 AM", "The lease Approval Status was changed from Pending to Approved", "Nicole Jones") +
    row("8/2/2026 10:00:00 AM", "Screening report approval pending review", "Nicole Jones");
  assert.equal(parseActivityLogApproval(html), null);
});

test("a denial is not an approval", () => {
  const html = HEADER + row("8/1/2026 10:00:00 AM", "Resident(s) Jane Doe denied for move in to unit 100", "Nicole Jones");
  assert.equal(parseActivityLogApproval(html), null);
});

test("re-approval after a transfer reports the FIRST approval", () => {
  // The log is newest-first. A lease approved, transferred and approved again
  // should date from when it was first approved, not the administrative echo.
  const html =
    HEADER +
    row("8/20/2026 1:00:00 PM", "Resident(s) Sam Ray approved for move in to unit 200", "Nicole Jones") +
    row("6/2/2026 8:00:00 AM", "Resident(s) Sam Ray approved for move in to unit 100", "Natalie Pointer");
  assert.deepEqual(parseActivityLogApproval(html), { date: "2026-06-02", by: "Natalie Pointer" });
});

test("a malformed timestamp is skipped rather than written as garbage", () => {
  const html = HEADER + row("not a date", "Resident(s) Sam Ray approved for move in to unit 100", "Nicole Jones");
  assert.equal(parseActivityLogApproval(html), null);
});

// ── Who pays for the extra request ──────────────────────────────────────────

test("only leases that are still applications get the extra request", () => {
  for (const status of ["Pending", "Approved", "Applicant", "Prospect", "pending"]) {
    assert.equal(isApplicationLeaseStatus(status), true, status);
  }
  for (const status of ["Current", "Former", "Evicted", "Denied", "Cancelled", "Notice to Vacate", ""]) {
    assert.equal(isApplicationLeaseStatus(status), false, status);
  }
});

test("Pending Renewal is NOT an application — nobody applied", () => {
  // It would cost a request per renewal to look for an approval that cannot
  // be there, and renewals are not on the Pipeline anyway.
  assert.equal(isApplicationLeaseStatus("Pending Renewal"), false);
});

// ── The mapped row ──────────────────────────────────────────────────────────

test("mapLease carries the approval through to the row", () => {
  const row = mapLease(
    { leaseId: "L1", status: "Approved", approvedDate: "7/7/2026", approvedBy: "Nicole Jones" },
    { unitId: "U1", unitNumber: "3712 EG-4", propertyId: "P1", isMostRecent: true },
  );
  assert.equal(row.approved_date, "2026-07-07");
  assert.equal(row.approved_by, "Nicole Jones");
});

test("a lease with no approval leaves the date null and the name empty", () => {
  const row = mapLease(
    { leaseId: "L1", status: "Pending" },
    { unitId: "U1", unitNumber: "3714 DU-2", propertyId: "P1", isMostRecent: true },
  );
  assert.equal(row.approved_date, null);
  assert.equal(row.approved_by, "");
});

// ── The rest of the log, free with the same request ─────────────────────────

/**
 * The Activity Log page is already being fetched for the approval date, and it
 * carries the rest of the leasing story. Measured across the 45 application
 * leases on this property (797 rows):
 *
 *   Online Application ......... 35 (78%), and 31 of those leases have NO
 *                                application_date on the resident page
 *   lease Start Date changed ... 36 (80%), 121 events, 35 of 36 moved LATER
 *                                (median 39 days, worst 196)
 *   Signature package sent 7 · signed 2 · voided 2
 */

test("the Online Application event dates the application", () => {
  const html = HEADER + row("7/13/2026 10:02:11 AM", "Online Application", "Anyone Home");
  assert.equal(parseActivityLog(html).onlineApplicationDate, "2026-07-13");
});

test("the ORIGINAL start date survives every later change", () => {
  // Newest-first, so the last row is the first change and holds the date the
  // lease originally had. This resident's move-in slid 8/07 → 8/21 → 9/01.
  const html =
    HEADER +
    row("8/10/2026 4:12:12 PM", "The lease Start Date was changed from 08/21/2026 to 09/01/2026", "Nicole Jones") +
    row("8/7/2026 9:34:50 AM", "The lease Start Date was changed from 08/07/2026 to 08/21/2026", "Nicole Jones");
  const f = parseActivityLog(html);
  assert.equal(f.startDateChanges, 2);
  assert.equal(f.originalStartDate, "2026-08-07");
});

test("a lease whose date never moved reports zero, not null", () => {
  const f = parseActivityLog(HEADER + row("7/1/2026 9:00:00 AM", "Online Application", "Anyone Home"));
  assert.equal(f.startDateChanges, 0);
  assert.equal(f.originalStartDate, null);
});

test("END date changes are not counted — they ride along with every start change", () => {
  // 115 End Date events accompany the 121 Start Date ones. Counting both would
  // roughly double every slip count.
  const html =
    HEADER +
    row("8/10/2026 4:12:12 PM", "The lease End Date was changed from 08/20/2027 to 08/31/2027", "Nicole Jones") +
    row("8/10/2026 4:12:12 PM", "The lease Start Date was changed from 08/21/2026 to 09/01/2026", "Nicole Jones");
  assert.equal(parseActivityLog(html).startDateChanges, 1);
});

test("signature package sent, signed and voided are each picked up", () => {
  const html =
    HEADER +
    row("7/20/2026 8:00:00 AM", "Signature package Emberly NEW was voided", "Nicias Teal") +
    row("7/18/2026 1:00:00 PM", "Signature package Emberly NEW was signed on 7/18/2026", "Nicias Teal") +
    row("7/17/2026 4:16:56 PM", "Signature package Emberly NEW was sent to Mamadou Saliou Diallo", "Nicias Teal");
  const f = parseActivityLog(html);
  assert.equal(f.leaseSentDate, "2026-07-17");
  assert.equal(f.leaseSignedDate, "2026-07-18");
  assert.equal(f.leaseVoidedDate, "2026-07-20");
});

test("the other signing wording is understood too", () => {
  const html = HEADER + row("6/2/2026 11:00:00 AM", "Resident(s) Eddie Wells signed their lease for unit 3714 DU-2", "Nicole Jones");
  assert.equal(parseActivityLog(html).leaseSignedDate, "2026-06-02");
});

test("'was signed on <date>' beats the row timestamp when they differ", () => {
  // The package can be reconciled days after it was actually signed.
  const html = HEADER + row("7/25/2026 9:00:00 AM", "Signature package Emberly NEW was signed on 7/18/2026", "Nicias Teal");
  assert.equal(parseActivityLog(html).leaseSignedDate, "2026-07-18");
});

test("an empty log yields all-nulls and no counts", () => {
  const f = parseActivityLog(HEADER);
  assert.equal(f.approvedDate, null);
  assert.equal(f.onlineApplicationDate, null);
  assert.equal(f.originalStartDate, null);
  assert.equal(f.startDateChanges, 0);
  assert.equal(f.leaseSentDate, null);
  assert.equal(f.leaseSignedDate, null);
  assert.equal(f.leaseVoidedDate, null);
});

test("the page's own dates are not overwritten by the log", () => {
  // Source-of-truth rule: the log fills a BLANK, it never second-guesses a
  // date ResMan states outright.
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "src", "resman", "scrapers", "unit-detail.ts"),
    "utf8",
  );
  assert.match(source, /if \(lease\.applicationDate === undefined\)/);
  assert.match(source, /if \(lease\.leaseSignedDate === undefined\)/);
});
