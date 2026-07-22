/**
 * Renewals derived-engine tests. All fixtures flow through the real zod
 * schemas (ManagerLeaseSchema / ResmanUnitSchema / RenewalOfferSchema) so
 * defaults and coercions match production, against a fixed local-time "now"
 * so calendar math is deterministic.
 */

// TS 6 doesn't auto-include @types packages; pull in bun:test declarations.
/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import { ManagerLeaseSchema, type ManagerLease } from "@/lib/api/leases";
import { RenewalOfferSchema, type RenewalOffer } from "@/lib/api/renewals";
import { ResmanUnitSchema, type ResmanUnit } from "@/lib/api/units";
import { unitFactsIndex } from "@/lib/derived/leasing";
import {
  buildInternalComps,
  buildOfferTimeline,
  buildRenewalMetrics,
  buildRenewalsBoard,
  defaultProposedRent,
  governingOfferByLease,
  offerSentMs,
  rentDelta,
  renewalSubject,
  unitForLease,
} from "@/lib/derived/renewals-view";
import { addDays, startOfDay } from "@/lib/derived/time";

// Tue 2026-07-21 noon, device-local.
const NOW = new Date("2026-07-21T12:00:00").getTime();

/** Local "YYYY-MM-DD" for a day offset from NOW. */
function day(offset: number): string {
  const d = new Date(startOfDay(addDays(NOW, offset)));
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** ISO timestamp (noon local) for a day offset from NOW. */
function stamp(offset: number): string {
  return new Date(addDays(NOW, offset)).toISOString();
}

let leaseSeq = 0;
function lease(fields: Partial<ManagerLease> = {}): ManagerLease {
  leaseSeq += 1;
  return ManagerLeaseSchema.parse({
    id: `lease-${leaseSeq}`,
    status: "Current",
    isCurrentLease: true,
    ...fields,
  });
}

let unitSeq = 0;
function unit(fields: Partial<ResmanUnit> = {}): ResmanUnit {
  unitSeq += 1;
  return ResmanUnitSchema.parse({
    resman_unit_id: `unit-${unitSeq}`,
    number: `U-${unitSeq}`,
    ...fields,
  });
}

let offerSeq = 0;
function offer(fields: Partial<RenewalOffer> = {}): RenewalOffer {
  offerSeq += 1;
  return RenewalOfferSchema.parse({
    id: `offer-${offerSeq}`,
    resmanLeaseId: "lease-x",
    proposedRent: 1300,
    status: "sent",
    ...fields,
  });
}

// ── Governing offer ─────────────────────────────────────────────────────────

describe("governingOfferByLease", () => {
  test("latest non-withdrawn offer governs; withdrawn never does", () => {
    const older = offer({ resmanLeaseId: "L", sentAt: stamp(-20), proposedRent: 1200 });
    const newest = offer({ resmanLeaseId: "L", sentAt: stamp(-2), status: "withdrawn" });
    const middle = offer({ resmanLeaseId: "L", sentAt: stamp(-8), proposedRent: 1290 });
    const governing = governingOfferByLease([older, newest, middle]);
    expect(governing.get("L")?.id).toBe(middle.id);
  });

  test("a lease with only withdrawn offers has no governing offer", () => {
    const only = offer({ resmanLeaseId: "L", sentAt: stamp(-5), status: "withdrawn" });
    expect(governingOfferByLease([only]).size).toBe(0);
  });

  test("offerSentMs prefers sentAt and falls back to createdAt", () => {
    const a = offer({ sentAt: stamp(-3), createdAt: stamp(-9) });
    const b = offer({ sentAt: null, createdAt: stamp(-9) });
    expect(offerSentMs(a)).toBe(Date.parse(stamp(-3)));
    expect(offerSentMs(b)).toBe(Date.parse(stamp(-9)));
    expect(offerSentMs(offer({ sentAt: null, createdAt: null }))).toBeNull();
  });
});

// ── The banded board ────────────────────────────────────────────────────────

describe("buildRenewalsBoard", () => {
  const u1 = unit({ number: "0327", tenant_names: ["Carmen Reyes"] });
  const u2 = unit({ number: "0509", tenant_names: ["Minh Tran"] });
  const unitsIdx = unitFactsIndex([u1, u2]);

  test("bands: needs offer (urgent + later), offer sent (silent split), resolved MTD", () => {
    const urgent = lease({ unitNumber: "0327", endDate: day(10), residentRent: 1240, marketRent: 1335 });
    const later = lease({ unitNumber: "0509", endDate: day(45), residentRent: 1180, marketRent: 1220 });
    const farOut = lease({ endDate: day(70) }); // outside the 60-day window
    const silentLease = lease({ unitNumber: "0433", endDate: day(40) });
    const freshLease = lease({ unitNumber: "0122", endDate: day(50) });
    const acceptedLease = lease({ unitNumber: "0815", endDate: day(30) });
    const declinedLease = lease({ unitNumber: "0112", endDate: day(25), moveOutDate: day(19) });
    const staleLease = lease({ unitNumber: "0700", endDate: day(55) });

    const offers = [
      offer({ resmanLeaseId: silentLease.id, sentAt: stamp(-11), proposedRent: 1310 }),
      offer({ resmanLeaseId: freshLease.id, sentAt: stamp(-5), proposedRent: 1405 }),
      offer({
        resmanLeaseId: acceptedLease.id,
        sentAt: stamp(-15),
        status: "accepted",
        respondedAt: stamp(-3),
        priorRent: 1335,
        proposedRent: 1410,
      }),
      offer({
        resmanLeaseId: declinedLease.id,
        sentAt: stamp(-12),
        status: "declined",
        respondedAt: stamp(-2),
        proposedRent: 1250,
      }),
      // Resolved BEFORE this calendar month — off the board entirely.
      offer({
        resmanLeaseId: staleLease.id,
        sentAt: stamp(-60),
        status: "accepted",
        respondedAt: stamp(-40),
        priorRent: 1000,
        proposedRent: 1100,
      }),
    ];

    const board = buildRenewalsBoard(
      [urgent, later, farOut, silentLease, freshLease, acceptedLease, declinedLease, staleLease],
      unitsIdx,
      offers,
      NOW,
    );

    // NEEDS OFFER: urgent (≤30d) first band, later (31–60) second; farOut absent.
    expect(board.needsOffer.map((r) => r.expiration.lease.id)).toEqual([urgent.id, later.id]);
    expect(board.needsOffer[0]!.urgent).toBe(true);
    expect(board.needsOffer[0]!.expiration.daysLeft).toBe(10);
    expect(board.needsOffer[0]!.expiration.tenantName).toBe("Carmen Reyes");
    expect(board.needsOffer[0]!.expiration.markToMarket).toBe(95);
    expect(board.needsOffer[1]!.urgent).toBe(false);

    // OFFER SENT: silent first.
    expect(board.offersOut.map((r) => r.offer.resmanLeaseId)).toEqual([
      silentLease.id,
      freshLease.id,
    ]);
    expect(board.offersOut[0]!.silent).toBe(true);
    expect(board.offersOut[0]!.daysSinceSent).toBe(11);
    expect(board.offersOut[1]!.silent).toBe(false);
    expect(board.offersOut[1]!.daysSinceSent).toBe(5);
    expect(board.silentCount).toBe(1);

    // RESOLVED THIS MONTH: newest response first, lift on accepted only.
    expect(board.resolvedThisMonth.map((r) => r.offer.resmanLeaseId)).toEqual([
      declinedLease.id,
      acceptedLease.id,
    ]);
    const accepted = board.resolvedThisMonth.find((r) => r.accepted)!;
    expect(accepted.lift).toBe(75);
    const declined = board.resolvedThisMonth.find((r) => !r.accepted)!;
    expect(declined.lift).toBeNull();

    // Lift MTD: only this month's accepted offers.
    expect(board.liftMtd).toEqual({ total: 75, accepted: 1, avg: 75 });
    expect(board.total).toBe(6);
  });

  test("a sent offer removes the lease from needs-offer; withdrawing restores it", () => {
    const expiring = lease({ unitNumber: "0327", endDate: day(20), residentRent: 1240 });
    const sent = offer({ resmanLeaseId: expiring.id, sentAt: stamp(-4) });

    const withOffer = buildRenewalsBoard([expiring], unitsIdx, [sent], NOW);
    expect(withOffer.needsOffer).toHaveLength(0);
    expect(withOffer.offersOut).toHaveLength(1);

    const withdrawn = { ...sent, status: "withdrawn" as const, respondedAt: stamp(-1) };
    const afterWithdraw = buildRenewalsBoard([expiring], unitsIdx, [withdrawn], NOW);
    expect(afterWithdraw.needsOffer).toHaveLength(1);
    expect(afterWithdraw.offersOut).toHaveLength(0);
    expect(afterWithdraw.resolvedThisMonth).toHaveLength(0);
  });

  test("renewed and notice/move-out leases never need an offer", () => {
    const renewedOld = lease({
      unitNumber: "0509",
      unitId: "u-509",
      endDate: day(15),
      startDate: day(-350),
    });
    const renewalOnUnit = lease({
      unitNumber: "0509",
      unitId: "u-509",
      startDate: day(20),
      endDate: day(380),
    });
    const onNotice = lease({ unitNumber: "0327", endDate: day(12), status: "Notice - Unrented" });

    const board = buildRenewalsBoard([renewedOld, renewalOnUnit, onNotice], unitsIdx, [], NOW);
    expect(board.needsOffer).toHaveLength(0);
  });

  test("metrics carry the mockup's three cells", () => {
    const urgent = lease({ unitNumber: "0327", endDate: day(10), residentRent: 1240, marketRent: 1335 });
    const silentLease = lease({ endDate: day(40) });
    const offers = [
      offer({ resmanLeaseId: silentLease.id, sentAt: stamp(-12), proposedRent: 1310 }),
      offer({
        resmanLeaseId: "gone-lease", // lease already dropped by the sync — soft ref survives
        sentAt: stamp(-9),
        status: "accepted",
        respondedAt: stamp(-1),
        priorRent: 1200,
        proposedRent: 1289,
      }),
    ];
    const board = buildRenewalsBoard([urgent, silentLease], unitsIdx, offers, NOW);
    const metrics = buildRenewalMetrics(board);
    expect(metrics.map((m) => m.key)).toEqual(["needOffer", "offersOut", "liftMtd"]);
    expect(metrics[0]!.value).toBe("1");
    expect(metrics[1]!.value).toBe("1");
    expect(metrics[1]!.captionParams).toEqual({ silent: 1 });
    expect(metrics[2]!.value).toBe("$89");
    expect(metrics[2]!.captionParams).toEqual({ accepted: 1, avg: "+$89" });
  });
});

// ── Offer-sheet subject ─────────────────────────────────────────────────────

describe("renewalSubject", () => {
  test("joins the unit mirror by id first, number as fallback", () => {
    const byId = unit({ resman_unit_id: "u-9", number: "0900", tenant_names: ["Ana"] });
    const byNumber = unit({ number: "0901", tenant_names: ["Bo"] });
    expect(unitForLease(lease({ unitId: "u-9", unitNumber: "0999" }), [byId, byNumber])?.number).toBe(
      "0900",
    );
    expect(unitForLease(lease({ unitNumber: "0901" }), [byId, byNumber])?.number).toBe("0901");
    expect(unitForLease(lease({ unitNumber: "none" }), [byId, byNumber])).toBeNull();
  });

  test("states tenant facts; 'never late' only when timesLate is known and zero", () => {
    const u = unit({
      number: "0327",
      tenant_names: ["Carmen Reyes", "Luis Reyes"],
      classification: "Diamond",
      bedrooms: 2,
      times_late: 0,
    });
    const s = renewalSubject(
      lease({
        unitNumber: "0327",
        moveInDate: "2024-05-01",
        endDate: day(10),
        residentRent: 1240,
        marketRent: 1335,
      }),
      [u],
    );
    expect(s.tenantName).toBe("Carmen Reyes");
    expect(s.classification).toBe("Diamond");
    expect(s.bedrooms).toBe(2);
    expect(s.neverLate).toBe(true);
    expect(s.markToMarket).toBe(95);

    // Unknown timesLate must NOT claim "never late".
    const unknown = renewalSubject(
      lease({ unitNumber: "0328" }),
      [unit({ number: "0328", times_late: null })],
    );
    expect(unknown.timesLate).toBeNull();
    expect(unknown.neverLate).toBe(false);

    const late = renewalSubject(
      lease({ unitNumber: "0329" }),
      [unit({ number: "0329", times_late: 3 })],
    );
    expect(late.neverLate).toBe(false);
  });
});

// ── Stepper helpers ─────────────────────────────────────────────────────────

describe("proposed-rent stepper", () => {
  test("defaults to market rent snapped to $5, falling back to current", () => {
    const u = unit({ number: "0327" });
    const withMarket = renewalSubject(
      lease({ unitNumber: "0327", marketRent: 1332, residentRent: 1240 }),
      [u],
    );
    expect(defaultProposedRent(withMarket)).toBe(1330);
    const noMarket = renewalSubject(
      lease({ unitNumber: "0327", marketRent: null, residentRent: 1243 }),
      [u],
    );
    expect(defaultProposedRent(noMarket)).toBe(1245);
  });

  test("rentDelta states the +$X · Y% chip, null when current rent unknown", () => {
    expect(rentDelta(1335, 1240)).toEqual({ amount: 95, pct: (95 / 1240) * 100 });
    expect(rentDelta(1200, 1240)).toEqual({ amount: -40, pct: (-40 / 1240) * 100 });
    expect(rentDelta(1335, null)).toBeNull();
    expect(rentDelta(1335, 0)).toEqual({ amount: 1335, pct: null });
  });
});

// ── Internal comps ──────────────────────────────────────────────────────────

describe("buildInternalComps", () => {
  // Subject: 2BR Diamond.
  const subjectUnit = unit({ number: "0327", classification: "Diamond", bedrooms: 2 });
  const subject = lease({ unitNumber: "0327", endDate: day(10), residentRent: 1240 });

  function comp(unitNumber: string, signedOffset: number, rent: number, u: Partial<ResmanUnit> = {}) {
    const compUnit = unit({ number: unitNumber, classification: "Diamond", bedrooms: 2, ...u });
    const compLease = lease({ unitNumber, signedDate: day(signedOffset), residentRent: rent });
    return { compUnit, compLease };
  }

  test("same classification + bedrooms signed in the last 90 days, 3 newest rents", () => {
    const a = comp("A1", -10, 1430);
    const b = comp("B2", -30, 1410);
    const c = comp("C3", -60, 1395);
    const d = comp("D4", -85, 1380); // 4th match: counts, not quoted
    const tooOld = comp("E5", -95, 1500);
    const wrongBeds = comp("F6", -5, 1600, { bedrooms: 3 });
    const wrongClass = comp("G7", -5, 1700, { classification: "Gold" });
    const noRent = comp("H8", -5, 0);
    noRent.compLease = lease({ unitNumber: "H8", signedDate: day(-5), residentRent: null });
    const denied = comp("I9", -5, 1800);
    denied.compLease = lease({
      unitNumber: "I9",
      signedDate: day(-5),
      residentRent: 1800,
      status: "Denied",
    });
    const future = comp("J10", 5, 1900);

    const all = [a, b, c, d, tooOld, wrongBeds, wrongClass, noRent, denied, future];
    const comps = buildInternalComps(
      subject,
      [subject, ...all.map((x) => x.compLease)],
      [subjectUnit, ...all.map((x) => x.compUnit)],
      NOW,
    );
    expect(comps).not.toBeNull();
    expect(comps!.classification).toBe("Diamond");
    expect(comps!.bedrooms).toBe(2);
    expect(comps!.count).toBe(4);
    expect(comps!.rents).toEqual([1430, 1410, 1395]); // newest signing first, capped at 3
    expect(comps!.minRent).toBe(1380);
    expect(comps!.maxRent).toBe(1430);
  });

  test("no comps without a known layout or without any qualifying signing", () => {
    // Subject unit unknown → null.
    expect(buildInternalComps(subject, [subject], [], NOW)).toBeNull();
    // Classification blank → null.
    const blankUnit = unit({ number: "0327", classification: "", bedrooms: 2 });
    expect(buildInternalComps(subject, [subject], [blankUnit], NOW)).toBeNull();
    // Bedrooms unknown → null.
    const noBeds = unit({ number: "0327", classification: "Diamond", bedrooms: null });
    expect(buildInternalComps(subject, [subject], [noBeds], NOW)).toBeNull();
    // Layout known but zero matches → null.
    expect(buildInternalComps(subject, [subject], [subjectUnit], NOW)).toBeNull();
  });

  test("the subject lease never comps itself", () => {
    const signedSubject = lease({
      unitNumber: "0327",
      signedDate: day(-10),
      residentRent: 1240,
      endDate: day(10),
    });
    expect(buildInternalComps(signedSubject, [signedSubject], [subjectUnit], NOW)).toBeNull();
  });
});

// ── Offer timeline ──────────────────────────────────────────────────────────

describe("buildOfferTimeline", () => {
  test("window opened + no-offer warning for an urgent unoffered lease", () => {
    const l = lease({ unitNumber: "0327", endDate: day(10) });
    const items = buildOfferTimeline(l, [], NOW);
    expect(items.map((i) => i.kind)).toEqual(["windowOpened", "noOfferYet"]);
    const opened = items[0]!;
    if (opened.kind === "windowOpened") {
      expect(opened.whenMs).toBe(startOfDay(addDays(NOW, -50))); // end − 60d
    }
    const none = items[1]!;
    if (none.kind === "noOfferYet") {
      expect(none.daysLeft).toBe(10);
      expect(none.urgent).toBe(true);
    }
  });

  test("offer events read oldest first with resolutions inline", () => {
    const l = lease({ endDate: day(40) });
    const first = offer({
      resmanLeaseId: l.id,
      sentAt: stamp(-20),
      status: "withdrawn",
      respondedAt: stamp(-15),
    });
    const second = offer({ resmanLeaseId: l.id, sentAt: stamp(-8) });
    const items = buildOfferTimeline(l, [first, second], NOW);
    expect(items.map((i) => i.kind)).toEqual([
      "windowOpened",
      "offerSent",
      "offerResolved",
      "offerSent",
    ]);
    // A live sent offer means no "no offer yet" row.
    expect(items.some((i) => i.kind === "noOfferYet")).toBe(false);
  });

  test("no window row before end − 60d; non-urgent warning reads plainly", () => {
    const l = lease({ endDate: day(65) });
    const items = buildOfferTimeline(l, [], NOW);
    expect(items.map((i) => i.kind)).toEqual(["noOfferYet"]);
    const none = items[0]!;
    if (none.kind === "noOfferYet") {
      expect(none.urgent).toBe(false);
      expect(none.daysLeft).toBe(65);
    }
  });
});
