import type { ManagerLease } from "@/lib/api/leases";
import type { RenewalOffer } from "@/lib/api/renewals";
import type { ResmanUnit } from "@/lib/api/units";
import {
  buildExpirationRows,
  isDeadLease,
  shortMoney,
  signedMoney,
  TINT,
  type ExpirationRow,
  type ScoreMetric,
  type UnitFacts,
} from "@/lib/derived/leasing";
import { addDays, calendarDaysBetween, parseDay, sameCalendarMonth, startOfDay } from "@/lib/derived/time";

/**
 * The Renewals derived engine — pure functions joining the expiring-lease
 * window (REUSED from lib/derived/leasing.ts's expirations logic, never
 * duplicated) with the Emberly-owned renewal_offers mirror into the mockup's
 * three bands: NEEDS OFFER → OFFER SENT → RESOLVED THIS MONTH. No I/O, no
 * store imports, no JSX; tests in tests/renewals-view.test.ts.
 *
 * GOVERNING OFFER: a lease's band is decided by its LATEST offer (by
 * sentAt, falling back to createdAt) whose status is not "withdrawn".
 * Withdrawn offers never govern — they only appear on the timeline — so
 * withdrawing an offer drops the lease straight back into NEEDS OFFER while
 * its window is open.
 */

// ── Window constants ────────────────────────────────────────────────────────

/** An expiring lease enters the renewal pipeline this many days out. */
export const RENEWAL_WINDOW_DAYS = 60;
/** Expiring within this many days with no offer = the red urgency band. */
export const RENEWAL_URGENT_DAYS = 30;
/** A sent offer with no response for more than this many days is "silent". */
export const SILENT_AFTER_DAYS = 10;

// ── Offer indexing ──────────────────────────────────────────────────────────

/** Best-effort event ms for ordering offers: sentAt, else createdAt. */
export function offerSentMs(offer: RenewalOffer): number | null {
  const raw = offer.sentAt ?? offer.createdAt;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : parseDay(raw);
}

/** All offers for each lease, newest first. */
export function offersByLease(offers: readonly RenewalOffer[]): Map<string, RenewalOffer[]> {
  const map = new Map<string, RenewalOffer[]>();
  for (const offer of offers) {
    const list = map.get(offer.resmanLeaseId);
    if (list) list.push(offer);
    else map.set(offer.resmanLeaseId, [offer]);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (offerSentMs(b) ?? 0) - (offerSentMs(a) ?? 0));
  }
  return map;
}

/** The governing (latest non-withdrawn) offer per lease — see module doc. */
export function governingOfferByLease(offers: readonly RenewalOffer[]): Map<string, RenewalOffer> {
  const out = new Map<string, RenewalOffer>();
  for (const [leaseId, list] of offersByLease(offers)) {
    const governing = list.find((o) => o.status !== "withdrawn");
    if (governing) out.set(leaseId, governing);
  }
  return out;
}

// ── The banded board ────────────────────────────────────────────────────────

export interface NeedsOfferRow {
  /** The reused expirations row: lease, tenantName, endMs, daysLeft, markToMarket. */
  expiration: ExpirationRow;
  /** daysLeft ≤ RENEWAL_URGENT_DAYS — the red band + "N days left" pill. */
  urgent: boolean;
}

export interface OfferSentRow {
  offer: RenewalOffer;
  /** The lease behind the offer, when it is still in the mirror (soft ref). */
  lease: ManagerLease | null;
  tenantName: string;
  sentMs: number | null;
  /** Whole days since the offer went out (0 when the send time is unknown). */
  daysSinceSent: number;
  /** No response for more than SILENT_AFTER_DAYS — "Silent Nd". */
  silent: boolean;
}

export interface ResolvedRow {
  offer: RenewalOffer;
  lease: ManagerLease | null;
  tenantName: string;
  accepted: boolean;
  /** proposedRent − priorRent for accepted offers (null when prior unknown). */
  lift: number | null;
}

export interface LiftMtd {
  /** Sum of accepted lifts responded this calendar month. */
  total: number;
  /** Accepted offers this calendar month (lift known or not). */
  accepted: number;
  /** total / count of lift-known accepted offers, 0 when none. */
  avg: number;
}

export interface RenewalsBoard {
  needsOffer: NeedsOfferRow[];
  offersOut: OfferSentRow[];
  resolvedThisMonth: ResolvedRow[];
  /** Board size for the mode pill (all three bands). */
  total: number;
  silentCount: number;
  liftMtd: LiftMtd;
}

/**
 * Assemble the Renewals board:
 *  - NEEDS OFFER — active leases expiring ≤ RENEWAL_WINDOW_DAYS (via the
 *    leasing engine's buildExpirationRows) whose renewal conversation is
 *    still open (state "open": not already renewed by a later lease, not on
 *    notice/moving out) and which have NO governing offer. Soonest end first;
 *    urgent = daysLeft ≤ 30.
 *  - OFFER SENT — governing offers still in status "sent", silent ones
 *    (> SILENT_AFTER_DAYS without a response) first, then oldest-sent first.
 *  - RESOLVED THIS MONTH — governing offers accepted/declined with a
 *    respondedAt in the current calendar month, newest response first.
 *    Accepted rows carry the lift chip (proposed − prior).
 */
export function buildRenewalsBoard(
  leases: readonly ManagerLease[],
  unitsByNumber: Map<string, UnitFacts>,
  offers: readonly RenewalOffer[],
  nowMs: number,
): RenewalsBoard {
  const today = startOfDay(nowMs);
  const governing = governingOfferByLease(offers);
  const leaseById = new Map(leases.map((l) => [l.id, l]));
  const tenantOf = (lease: ManagerLease | null, offer?: RenewalOffer): string => {
    const unitNumber = lease?.unitNumber || offer?.unitNumber || "";
    return unitsByNumber.get(unitNumber)?.tenantNames[0] ?? "";
  };

  const expirations = buildExpirationRows([...leases], unitsByNumber, nowMs, RENEWAL_WINDOW_DAYS);
  const needsOffer: NeedsOfferRow[] = expirations
    .filter((row) => row.state === "open" && !governing.has(row.lease.id))
    .map((row) => ({ expiration: row, urgent: row.daysLeft <= RENEWAL_URGENT_DAYS }));

  const offersOut: OfferSentRow[] = [];
  const resolvedThisMonth: ResolvedRow[] = [];
  for (const offer of governing.values()) {
    const lease = leaseById.get(offer.resmanLeaseId) ?? null;
    if (offer.status === "sent") {
      const sentMs = offerSentMs(offer);
      const daysSinceSent = sentMs !== null ? Math.max(0, calendarDaysBetween(sentMs, today)) : 0;
      offersOut.push({
        offer,
        lease,
        tenantName: tenantOf(lease, offer),
        sentMs,
        daysSinceSent,
        silent: daysSinceSent > SILENT_AFTER_DAYS,
      });
      continue;
    }
    // accepted / declined — only this calendar month's responses stay on the board.
    const respondedMs = offer.respondedAt ? Date.parse(offer.respondedAt) : NaN;
    if (!Number.isFinite(respondedMs) || !sameCalendarMonth(respondedMs, nowMs)) continue;
    const accepted = offer.status === "accepted";
    resolvedThisMonth.push({
      offer,
      lease,
      tenantName: tenantOf(lease, offer),
      accepted,
      lift:
        accepted && typeof offer.priorRent === "number"
          ? offer.proposedRent - offer.priorRent
          : null,
    });
  }

  offersOut.sort((a, b) => {
    if (a.silent !== b.silent) return a.silent ? -1 : 1;
    return b.daysSinceSent - a.daysSinceSent;
  });
  resolvedThisMonth.sort(
    (a, b) => Date.parse(b.offer.respondedAt ?? "") - Date.parse(a.offer.respondedAt ?? ""),
  );

  const acceptedRows = resolvedThisMonth.filter((r) => r.accepted);
  const liftKnown = acceptedRows.filter((r) => r.lift !== null);
  const total = liftKnown.reduce((sum, r) => sum + (r.lift as number), 0);

  return {
    needsOffer,
    offersOut,
    resolvedThisMonth,
    total: needsOffer.length + offersOut.length + resolvedThisMonth.length,
    silentCount: offersOut.filter((r) => r.silent).length,
    liftMtd: {
      total,
      accepted: acceptedRows.length,
      avg: liftKnown.length > 0 ? total / liftKnown.length : 0,
    },
  };
}

/** The three header metrics: Need an offer · Offers out · Lift captured MTD. */
export function buildRenewalMetrics(board: RenewalsBoard): ScoreMetric[] {
  return [
    {
      key: "needOffer",
      value: String(board.needsOffer.length),
      tint: TINT.amber,
      labelKey: "leasing.renewals.metrics.needOffer",
      captionKey: "leasing.renewals.metrics.needOfferCaption",
    },
    {
      key: "offersOut",
      value: String(board.offersOut.length),
      tint: TINT.blue,
      labelKey: "leasing.renewals.metrics.offersOut",
      captionKey: "leasing.renewals.metrics.offersOutCaption",
      captionParams: { silent: board.silentCount },
    },
    {
      key: "liftMtd",
      value: shortMoney(board.liftMtd.total),
      tint: TINT.green,
      labelKey: "leasing.renewals.metrics.liftMtd",
      captionKey: "leasing.renewals.metrics.liftMtdCaption",
      captionParams: {
        accepted: board.liftMtd.accepted,
        avg: signedMoney(board.liftMtd.avg),
      },
    },
  ];
}

// ── Offer-sheet subject ─────────────────────────────────────────────────────

/** Find the lease's unit in the mirror: by resman id first, else by number. */
export function unitForLease(
  lease: ManagerLease,
  units: readonly ResmanUnit[],
): ResmanUnit | null {
  if (lease.unitId) {
    const byId = units.find((u) => u.resman_unit_id === lease.unitId);
    if (byId) return byId;
  }
  if (lease.unitNumber !== "") {
    return units.find((u) => u.number === lease.unitNumber) ?? null;
  }
  return null;
}

export interface RenewalSubject {
  tenantName: string;
  classification: string;
  bedrooms: number | null;
  /** timesLate from the unit mirror; null when the field is unknown. */
  timesLate: number | null;
  /** "never late" may only be claimed when timesLate is known AND zero. */
  neverLate: boolean;
  /** moveInDate ?? startDate as local-midnight ms. */
  inSinceMs: number | null;
  endMs: number | null;
  currentRent: number | null;
  marketRent: number | null;
  /** marketRent − currentRent, null when either side is unknown. */
  markToMarket: number | null;
}

/** Everything the offer sheet's header states about the tenant/unit. */
export function renewalSubject(lease: ManagerLease, units: readonly ResmanUnit[]): RenewalSubject {
  const unit = unitForLease(lease, units);
  const timesLate = typeof unit?.times_late === "number" ? unit.times_late : null;
  const currentRent = lease.residentRent ?? null;
  const marketRent = lease.marketRent ?? unit?.market_rent ?? null;
  return {
    tenantName: unit?.tenant_names[0] ?? "",
    classification: unit?.classification ?? "",
    bedrooms: typeof unit?.bedrooms === "number" ? unit.bedrooms : null,
    timesLate,
    neverLate: timesLate === 0,
    inSinceMs: parseDay(lease.moveInDate) ?? parseDay(lease.startDate),
    endMs: parseDay(lease.endDate),
    currentRent,
    marketRent,
    markToMarket: marketRent !== null && currentRent !== null ? marketRent - currentRent : null,
  };
}

// ── Proposed-rent stepper ───────────────────────────────────────────────────

/** The stepper moves in $5 steps. */
export const RENT_STEP = 5;

/** Default proposal = market rent (else current rent), snapped to a $5 step. */
export function defaultProposedRent(subject: RenewalSubject): number {
  const base = subject.marketRent ?? subject.currentRent ?? 0;
  return Math.max(0, Math.round(base / RENT_STEP) * RENT_STEP);
}

export interface RentDelta {
  amount: number;
  /** Percent of current rent, null when current rent is unknown/zero. */
  pct: number | null;
}

/** The live "+$X · Y%" chip beside the stepper (null when current unknown). */
export function rentDelta(proposed: number, currentRent: number | null): RentDelta | null {
  if (currentRent === null) return null;
  const amount = proposed - currentRent;
  return { amount, pct: currentRent > 0 ? (amount / currentRent) * 100 : null };
}

// ── Internal comps ──────────────────────────────────────────────────────────

/** Comps look back this many days over signed leases. */
export const COMPS_WINDOW_DAYS = 90;
/** At most this many recent signed rents are quoted. */
export const COMPS_MAX = 3;

export interface InternalComps {
  classification: string;
  bedrooms: number;
  /** Total qualifying signings in the window (may exceed rents.length). */
  count: number;
  /** Up to COMPS_MAX most-recent signed rents, newest signing first. */
  rents: number[];
  minRent: number;
  maxRent: number;
}

/**
 * INTERNAL COMPS MATCHING RULE (build note: "Comps are internal" — no
 * external comp service, no scraping; the property's own signings are the
 * sample). A lease qualifies as a comp for the subject lease when:
 *  - the subject's unit is known in the units mirror with a non-empty
 *    classification AND a known bedrooms count (otherwise no comps: null);
 *  - the candidate signedDate falls within the last COMPS_WINDOW_DAYS
 *    (today inclusive, never the future);
 *  - the candidate is not the subject lease, not denied/cancelled, and its
 *    residentRent is known;
 *  - the candidate's own unit (id first, number fallback) matches the
 *    subject's classification case-insensitively AND its exact bedrooms.
 * The result quotes the COMPS_MAX most recent signed rents, newest first,
 * plus min/max over ALL qualifying signings for the comparison sentence.
 */
export function buildInternalComps(
  subject: ManagerLease,
  leases: readonly ManagerLease[],
  units: readonly ResmanUnit[],
  nowMs: number,
): InternalComps | null {
  const subjectUnit = unitForLease(subject, units);
  const classification = (subjectUnit?.classification ?? "").trim();
  const bedrooms = typeof subjectUnit?.bedrooms === "number" ? subjectUnit.bedrooms : null;
  if (classification === "" || bedrooms === null) return null;

  const today = startOfDay(nowMs);
  const floor = addDays(today, -COMPS_WINDOW_DAYS);
  const classLower = classification.toLowerCase();

  const matches: { signedMs: number; rent: number }[] = [];
  for (const lease of leases) {
    if (lease.id === subject.id || isDeadLease(lease)) continue;
    const signedMs = parseDay(lease.signedDate);
    if (signedMs === null || signedMs < floor || signedMs > today) continue;
    const rent = lease.residentRent ?? null;
    if (rent === null) continue;
    const unit = unitForLease(lease, units);
    if (!unit) continue;
    if ((unit.classification ?? "").trim().toLowerCase() !== classLower) continue;
    if (typeof unit.bedrooms !== "number" || unit.bedrooms !== bedrooms) continue;
    matches.push({ signedMs, rent });
  }
  if (matches.length === 0) return null;

  matches.sort((a, b) => b.signedMs - a.signedMs);
  const rents = matches.slice(0, COMPS_MAX).map((m) => m.rent);
  const all = matches.map((m) => m.rent);
  return {
    classification,
    bedrooms,
    count: matches.length,
    rents,
    minRent: Math.min(...all),
    maxRent: Math.max(...all),
  };
}

// ── Offer timeline ──────────────────────────────────────────────────────────

export type OfferTimelineItem =
  | { key: string; kind: "windowOpened"; whenMs: number }
  | { key: string; kind: "offerSent"; whenMs: number | null; offer: RenewalOffer }
  | { key: string; kind: "offerResolved"; whenMs: number | null; offer: RenewalOffer }
  | { key: string; kind: "noOfferYet"; daysLeft: number | null; urgent: boolean };

/**
 * The sheet's TIMELINE, derived purely from lease dates + offers, oldest
 * first: the expiry window opening (end − RENEWAL_WINDOW_DAYS, once it has
 * happened), every offer's send and resolution, and — while the lease has no
 * governing offer — the gray "No offer sent yet" row with the days-to-end
 * warning that explains a red band.
 */
export function buildOfferTimeline(
  lease: ManagerLease,
  offers: readonly RenewalOffer[],
  nowMs: number,
): OfferTimelineItem[] {
  const today = startOfDay(nowMs);
  const items: OfferTimelineItem[] = [];

  const endMs = parseDay(lease.endDate);
  if (endMs !== null) {
    const openedMs = addDays(endMs, -RENEWAL_WINDOW_DAYS);
    if (openedMs <= today) items.push({ key: "window", kind: "windowOpened", whenMs: openedMs });
  }

  const mine = (offersByLease(offers).get(lease.id) ?? []).slice().reverse(); // oldest first
  for (const offer of mine) {
    items.push({ key: `sent-${offer.id}`, kind: "offerSent", whenMs: offerSentMs(offer), offer });
    if (offer.status !== "sent") {
      const respondedMs = offer.respondedAt ? Date.parse(offer.respondedAt) : NaN;
      items.push({
        key: `resolved-${offer.id}`,
        kind: "offerResolved",
        whenMs: Number.isFinite(respondedMs) ? respondedMs : null,
        offer,
      });
    }
  }

  const hasGoverning = mine.some((o) => o.status !== "withdrawn");
  if (!hasGoverning) {
    const daysLeft = endMs !== null ? calendarDaysBetween(today, endMs) : null;
    items.push({
      key: "none",
      kind: "noOfferYet",
      daysLeft,
      urgent: daysLeft !== null && daysLeft <= RENEWAL_URGENT_DAYS,
    });
  }
  return items;
}
