const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ALWAYS_FULL_SCRAPE_STATUSES,
  APPLICATION_LEASE_STATUS_PATTERNS,
  NO_LEDGER_STATUSES,
  leaseScrapeTier,
  qualifyingLeaseOrFilter,
} = require("../src/resman/jobs/unit-detail");

/**
 * Which leases the deep scrape fetches.
 *
 * The filter used to be current/most-recent only. An application in flight is
 * NEITHER — the unit it is for usually still houses a resident whose lease
 * holds both flags — so no pending application had ever been deep-scraped, and
 * all 63 of them sat in the mirror as bare shells: a status and nothing else.
 * The manager app's Pipeline board reads application_date, leasing_agent and
 * move_in_date, so it rendered anonymous rows that could not name the prospect
 * or the agent who owned the deal.
 */

/** Rows the `or=` expression should admit, as (status, flags) cases. */
function matches(filter, { status = "", current = false, mostRecent = false }) {
  return filter.split(",").some((clause) => {
    if (clause === "is_current_lease.eq.true") return current;
    if (clause === "is_most_recent_lease.eq.true") return mostRecent;
    const m = clause.match(/^status\.ilike\.(.+)$/);
    if (!m) return false;
    const re = new RegExp(`^${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, "i");
    return re.test(status);
  });
}

test("residencies still qualify exactly as before", () => {
  const f = qualifyingLeaseOrFilter();
  assert.ok(matches(f, { status: "Current", current: true }));
  assert.ok(matches(f, { status: "Former", mostRecent: true }));
  assert.ok(matches(f, { status: "Under Eviction", current: true }));
});

test("in-flight applications now qualify — the 63 rows that were never scraped", () => {
  const f = qualifyingLeaseOrFilter();
  // Neither flag set: this is precisely the shape that used to be skipped.
  for (const status of ["Pending", "Pending Renewal", "Approved", "Applicant", "Prospect"]) {
    assert.ok(matches(f, { status }), `${status} must be scraped`);
  }
});

test("ilike is case-insensitive, so ResMan's casing cannot silently drop a row", () => {
  const f = qualifyingLeaseOrFilter();
  assert.ok(matches(f, { status: "PENDING" }));
  assert.ok(matches(f, { status: "pending renewal" }));
});

test("settled and dead leases are still not scraped on status alone", () => {
  const f = qualifyingLeaseOrFilter();
  // These carry no flags in the mirror and are not applications; scraping them
  // would add hundreds of pointless requests against a rate-limited portal.
  for (const status of ["Denied", "Cancelled", "Renewed", "Evicted", "Former"]) {
    assert.equal(matches(f, { status }), false, `${status} must not qualify on status alone`);
  }
});

test("the pattern list stays server-side matchable (ilike globs, not regex)", () => {
  for (const p of APPLICATION_LEASE_STATUS_PATTERNS) {
    assert.match(p, /^[a-z]+%$/, `${p} must be a simple ilike prefix glob`);
  }
  // "Pending Renewal" is caught by the "pending%" prefix — no second entry.
  assert.ok(APPLICATION_LEASE_STATUS_PATTERNS.includes("pending%"));
  assert.equal(APPLICATION_LEASE_STATUS_PATTERNS.includes("pending renewal%"), false);
});

test("a lease never deep-captured qualifies whatever its status", () => {
  // The `deep_synced_at.is.null` clause is what makes "every lease type gets
  // scraped at least once" true — a settled Former lease that predates the
  // deep sync would otherwise never be read.
  assert.ok(qualifyingLeaseOrFilter().includes("deep_synced_at.is.null"));
});

// ── Tier: how much of each lease to re-read ─────────────────────────────────

test("never captured -> FULL, whatever the status", () => {
  for (const status of ["Former", "Evicted", "Denied", "Pending", "Current", "", null]) {
    assert.equal(
      leaseScrapeTier({ status, deep_synced_at: null }),
      "full",
      `${status} with no capture must be full`,
    );
  }
});

test("statuses where someone still lives in the unit stay FULL on every run", () => {
  const CAPTURED = "2026-08-01T00:00:00Z";
  for (const status of [
    "Current",
    "Pending Renewal",
    "Notice to Vacate",
    "Under Eviction",
    "Month to Month",
    "current",
    "UNDER EVICTION",
  ]) {
    assert.equal(
      leaseScrapeTier({ status, deep_synced_at: CAPTURED }),
      "full",
      `${status} must keep re-reading its fields`,
    );
  }
  assert.deepEqual(ALWAYS_FULL_SCRAPE_STATUSES, [
    // Live residencies…
    "current",
    "pending renewal",
    "notice",
    "eviction",
    "month to month",
    // …and live applications, which change until they move in or are denied.
    "pending",
    "approved",
    "applicant",
    "prospect",
  ]);
});

test("'Under Eviction' re-reads but 'Evicted' does not — the substring must discriminate", () => {
  // This is the whole reason the key is "eviction" and not "evict":
  // "Under Eviction" is a resident still in the unit whose set-out date is
  // still being written; "Evicted" is terminal and immutable. "evicted" does
  // not contain "eviction", so one word separates a re-read from a skip.
  const CAPTURED = "2026-08-01T00:00:00Z";
  assert.equal(leaseScrapeTier({ status: "Under Eviction", deep_synced_at: CAPTURED }), "full");
  assert.equal(leaseScrapeTier({ status: "Evicted", deep_synced_at: CAPTURED }), "ledger");
  assert.equal("evicted".includes("eviction"), false, "the discriminator itself");
});

test("an ENDED TENANCY drops to ledger-only — the money still moves", () => {
  // Collections, write-offs and final-account activity run for months after
  // the resident has gone, so these keep a cheap two-request ledger refresh.
  for (const status of ["Former", "Evicted", "Renewed"]) {
    assert.equal(
      leaseScrapeTier({ status, deep_synced_at: "2026-08-01T00:00:00Z" }),
      "ledger",
      `${status} must stay on ledger refresh`,
    );
  }
});

/**
 * A LIVE APPLICATION IS RE-READ EVERY RUN, until it moves in or is turned down.
 *
 * It was captured once and then frozen, which meant the board reported the
 * state the application had on the day it was first seen. That is wrong for
 * exactly the fields a leasing manager watches: 80% of applications on this
 * property have already moved their desired move-in (median 39 days later),
 * approvals land, signature packages go out, get signed, or get voided.
 *
 * It also removed the only repair path. When the skeleton write blanked the
 * leasing agent and dates on 40 applications, the deep pass would not look at
 * them again — because they were already `deep_synced_at` — so the damage was
 * permanent until a manual re-queue.
 */
test("a LIVE application is re-read every run — it is not a settled record", () => {
  const CAPTURED = "2026-08-01T00:00:00Z";
  for (const status of ["Pending", "Approved", "Applicant", "Prospect"]) {
    assert.equal(
      leaseScrapeTier({ status, deep_synced_at: CAPTURED }),
      "full",
      `${status} keeps changing until move-in or denial`,
    );
  }
});

test("a DEAD application is skipped entirely — no tenancy, so no ledger", () => {
  // Only the two terminal outcomes. These never became a tenancy, so no rent
  // was ever charged against them and there is no ledger that can move.
  for (const status of ["Denied", "Cancelled"]) {
    assert.equal(
      leaseScrapeTier({ status, deep_synced_at: "2026-08-01T00:00:00Z" }),
      "skip",
      `${status} is finished`,
    );
  }
  assert.deepEqual([...NO_LEDGER_STATUSES].sort(), ["cancel", "denied"]);
});

test("the application lifecycle: read every run, then stop at the outcome", () => {
  const CAPTURED = "2026-08-01T00:00:00Z";
  // Applied, still in flight — read every run…
  assert.equal(leaseScrapeTier({ status: "Pending", deep_synced_at: CAPTURED }), "full");
  assert.equal(leaseScrapeTier({ status: "Approved", deep_synced_at: CAPTURED }), "full");
  // …then one of the two endings.
  assert.equal(leaseScrapeTier({ status: "Current", deep_synced_at: CAPTURED }), "full", "moved in");
  assert.equal(leaseScrapeTier({ status: "Denied", deep_synced_at: CAPTURED }), "skip", "turned down");
});

test("'Pending Renewal' is a live negotiation and stays full", () => {
  // The old ordering trap — "Pending Renewal" contains "pending" — is now
  // harmless, since both are full. Pinned anyway: if "pending" ever moves back
  // to the skip list, renewals must not be caught by it.
  const CAPTURED = "2026-08-01T00:00:00Z";
  assert.equal(leaseScrapeTier({ status: "Pending Renewal", deep_synced_at: CAPTURED }), "full");
  assert.equal(NO_LEDGER_STATUSES.includes("pending"), false, "no longer a skip key");
});

test("a Former lease: exactly ONE full scrape, then ledger forever", () => {
  // The whole lifecycle contract in one place.
  //
  // The one full capture is not ceremony: reason_for_leaving lives ONLY on the
  // lease detail page (the shallow lease-history pass carries move_out_date but
  // not the reason), and the move-out reporting reads it. A resident who skips
  // without notice goes Current → Former directly, never passing through the
  // always-full "Notice to Vacate" stage, so this capture is the only chance to
  // record why they left. After it, nothing but the ledger can still move.
  assert.equal(leaseScrapeTier({ status: "Former", deep_synced_at: null }), "full");
  assert.equal(leaseScrapeTier({ status: "Former", deep_synced_at: "2026-08-01T00:00:00Z" }), "ledger");
  assert.equal(leaseScrapeTier({ status: "Evicted", deep_synced_at: null }), "full");
  assert.equal(leaseScrapeTier({ status: "Evicted", deep_synced_at: "2026-08-01T00:00:00Z" }), "ledger");

  // And the guarantee reaches leases the flag-based clauses would miss: an old
  // Former lease from three tenants ago is neither current nor most-recent, so
  // only `deep_synced_at.is.null` can pull it in for that one capture.
  assert.ok(qualifyingLeaseOrFilter().includes("deep_synced_at.is.null"));
});

test("an unrecognized status defaults to ledger, not skip", () => {
  // If ResMan invents a status, two requests to keep the money current is the
  // safe wrong answer; silently never reading it again is not.
  assert.equal(
    leaseScrapeTier({ status: "Some New ResMan Status", deep_synced_at: "2026-08-01T00:00:00Z" }),
    "ledger",
  );
});
