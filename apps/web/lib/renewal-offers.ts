import type { AccessTokenSubject } from "@/lib/access-tokens";
import type { Database } from "@/types/database";
import type { UntypedSupabase } from "@/lib/supabase/types";

/**
 * Renewal-offer pipeline for the manager app — the delinquency_actions
 * pattern again. Property managers send renewal offers against an expiring
 * lease and later record the response; the phone derives the Renewals board
 * (needs offer → offer sent → resolved, plus the lift metric) from these rows
 * on device. Emberly-only writes — ResMan stays the lease of record. The
 * lease reference is soft: the sync's delete-missing pass may remove a lease,
 * but the offer history must survive it, so rows are soft deleted
 * (deleted_at) and never cascade. term_months null + is_month_to_month true
 * is a month-to-month offer (the MTM premium is just the proposed_rent).
 */

export type RenewalOfferRow = Database["public"]["Tables"]["renewal_offers"]["Row"];
export type RenewalOfferStatus = RenewalOfferRow["status"];

export const RENEWAL_OFFER_STATUSES = [
  "sent",
  "accepted",
  "declined",
  "withdrawn",
] as const satisfies readonly RenewalOfferStatus[];

/** The statuses a PATCH may move an offer to (everything but "sent"). */
export const RENEWAL_RESOLUTION_STATUSES = [
  "accepted",
  "declined",
  "withdrawn",
] as const satisfies readonly RenewalOfferStatus[];

export interface RenewalOfferActor {
  createdBy: string;
  createdByAdminId: string;
}

/**
 * Attribution from a `requireResmanApiKey` success, exactly like
 * delinquencyActionActor: token callers record the token's label (the staff
 * display name for admin-minted app tokens) plus the admin id when the
 * subject is an admin user. Scanner callers never reach the manager surface
 * (the routes 403 them), but the shape stays total for safety.
 */
export function renewalOfferActor(
  auth: { kind: "token"; subject: AccessTokenSubject } | { kind: "scanner" },
): RenewalOfferActor {
  if (auth.kind === "token") {
    return {
      createdBy: auth.subject.label,
      createdByAdminId: auth.subject.subjectType === "admin_user" ? auth.subject.subjectId : "",
    };
  }
  return { createdBy: "scanner", createdByAdminId: "" };
}

/** The renewal_offers columns the mobile payload carries. */
export const RENEWAL_OFFER_COLUMNS =
  "id, resman_lease_id, resman_unit_id, unit_number, prior_rent, proposed_rent, " +
  "term_months, is_month_to_month, status, sent_at, responded_at, note, created_by, created_at";

/** The subset of the row the API selects (created_by_admin_id stays internal). */
export type RenewalOfferSelect = Pick<
  RenewalOfferRow,
  | "id"
  | "resman_lease_id"
  | "resman_unit_id"
  | "unit_number"
  | "prior_rent"
  | "proposed_rent"
  | "term_months"
  | "is_month_to_month"
  | "status"
  | "sent_at"
  | "responded_at"
  | "note"
  | "created_by"
  | "created_at"
>;

/** One offer, camelCased for the wire. */
export interface RenewalOfferPayload {
  id: string;
  resmanLeaseId: string;
  resmanUnitId: string;
  unitNumber: string;
  priorRent: number | null;
  proposedRent: number;
  termMonths: number | null;
  isMonthToMonth: boolean;
  status: RenewalOfferStatus;
  sentAt: string | null;
  respondedAt: string | null;
  note: string;
  createdBy: string;
  createdAt: string | null;
}

export function renewalOfferPayload(row: RenewalOfferSelect): RenewalOfferPayload {
  return {
    id: row.id,
    resmanLeaseId: row.resman_lease_id,
    resmanUnitId: row.resman_unit_id,
    unitNumber: row.unit_number,
    priorRent: row.prior_rent,
    proposedRent: row.proposed_rent,
    termMonths: row.term_months,
    isMonthToMonth: row.is_month_to_month,
    status: row.status,
    sentAt: row.sent_at,
    respondedAt: row.responded_at,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** All non-deleted offers, newest first (the phone bands them on device). */
export async function listRenewalOffers(client: UntypedSupabase): Promise<RenewalOfferPayload[]> {
  const { data, error } = await client
    .from("renewal_offers")
    .select(RENEWAL_OFFER_COLUMNS)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as RenewalOfferSelect[]).map(renewalOfferPayload);
}

export interface RenewalOfferInput {
  resmanLeaseId: string;
  resmanUnitId?: string;
  unitNumber?: string;
  priorRent?: number;
  proposedRent: number;
  termMonths?: number;
  isMonthToMonth?: boolean;
  note?: string;
}

/** Record one sent offer; returns the stored row's payload. */
export async function createRenewalOffer(
  client: UntypedSupabase,
  input: RenewalOfferInput,
  actor: RenewalOfferActor,
): Promise<RenewalOfferPayload> {
  const { data, error } = await client
    .from("renewal_offers")
    .insert({
      resman_lease_id: input.resmanLeaseId,
      resman_unit_id: input.resmanUnitId ?? "",
      unit_number: input.unitNumber ?? "",
      prior_rent: input.priorRent ?? null,
      proposed_rent: input.proposedRent,
      term_months: input.termMonths ?? null,
      is_month_to_month: input.isMonthToMonth ?? false,
      note: input.note ?? "",
      created_by: actor.createdBy,
      created_by_admin_id: actor.createdByAdminId,
    })
    .select(RENEWAL_OFFER_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return renewalOfferPayload(data as RenewalOfferSelect);
}

export type ResolveRenewalOfferResult =
  | { outcome: "resolved"; offer: RenewalOfferPayload }
  | { outcome: "not_found" }
  | { outcome: "already_resolved" };

/**
 * Resolve one offer: sent → accepted/declined/withdrawn, stamping
 * responded_at. Unknown or soft-deleted ids report not_found (the route
 * answers 404); an offer that already left "sent" reports already_resolved
 * (400) — a response is recorded once, never rewritten.
 */
export async function resolveRenewalOffer(
  client: UntypedSupabase,
  id: string,
  status: (typeof RENEWAL_RESOLUTION_STATUSES)[number],
): Promise<ResolveRenewalOfferResult> {
  const { data: existing } = await client
    .from("renewal_offers")
    .select("id, status")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!existing) return { outcome: "not_found" };
  if ((existing as { status: RenewalOfferStatus }).status !== "sent") {
    return { outcome: "already_resolved" };
  }

  const { data, error } = await client
    .from("renewal_offers")
    .update({ status, responded_at: new Date().toISOString() })
    .eq("id", id)
    .select(RENEWAL_OFFER_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return { outcome: "resolved", offer: renewalOfferPayload(data as RenewalOfferSelect) };
}
