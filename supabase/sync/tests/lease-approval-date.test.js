const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isApplicationLeaseStatus,
  parseActivityLogApproval,
} = require("../src/resman/scrapers/unit-detail");
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
