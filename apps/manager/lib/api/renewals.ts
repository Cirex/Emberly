import { z } from "zod";
import { apiJson } from "@/lib/api/client";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * Renewals feature API: the Emberly-owned renewal-offer pipeline
 * (GET/POST /api/resman/manager/renewal-offers, PATCH .../[id]). ResMan stays
 * the lease of record — these rows only track what Emberly did about each
 * expiring lease (offer sent → accepted/declined/withdrawn), exactly like the
 * delinquency action timeline. The lease mirror itself comes from the Leasing
 * feature's module (lib/api/leases.ts); this file owns only the offer wire
 * schema.
 */

const num = z.number().nullable().optional();

export const RENEWAL_OFFER_STATUSES = ["sent", "accepted", "declined", "withdrawn"] as const;
export type RenewalOfferStatus = (typeof RENEWAL_OFFER_STATUSES)[number];

/** The statuses a resolve may move an offer to (everything but "sent"). */
export const RENEWAL_RESOLUTION_STATUSES = ["accepted", "declined", "withdrawn"] as const;
export type RenewalResolutionStatus = (typeof RENEWAL_RESOLUTION_STATUSES)[number];

export const RenewalOfferSchema = z.object({
  id: z.string(),
  resmanLeaseId: z.string(),
  resmanUnitId: z.string().default(""),
  unitNumber: z.string().default(""),
  priorRent: num,
  proposedRent: z.number(),
  termMonths: num,
  isMonthToMonth: z.boolean().default(false),
  status: z.enum(RENEWAL_OFFER_STATUSES),
  sentAt: z.string().nullable().optional(),
  respondedAt: z.string().nullable().optional(),
  note: z.string().default(""),
  createdBy: z.string().default(""),
  createdAt: z.string().nullable().optional(),
});
export type RenewalOffer = z.infer<typeof RenewalOfferSchema>;

const ListSchema = z.object({ data: z.object({ offers: z.array(RenewalOfferSchema) }) });

/** Every live offer, newest first — the board bands them on device. */
export async function fetchRenewalOffers(config: StaffConfig): Promise<RenewalOffer[]> {
  const json = await apiJson("/api/resman/manager/renewal-offers", config);
  return ListSchema.parse(json).data.offers;
}

export interface RenewalOfferInput {
  resmanLeaseId: string;
  resmanUnitId?: string;
  unitNumber?: string;
  priorRent?: number;
  proposedRent: number;
  /** Whole months; omitted for month-to-month offers. */
  termMonths?: number;
  isMonthToMonth?: boolean;
  note?: string;
}

const CreatedSchema = z.object({ data: RenewalOfferSchema });

/** Send (record) one renewal offer; returns the stored server row. */
export async function createRenewalOffer(
  config: StaffConfig,
  input: RenewalOfferInput,
): Promise<RenewalOffer> {
  const json = await apiJson("/api/resman/manager/renewal-offers", config, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return CreatedSchema.parse(json).data;
}

/** Record the response (or withdraw); the server stamps respondedAt. */
export async function resolveRenewalOffer(
  config: StaffConfig,
  id: string,
  status: RenewalResolutionStatus,
): Promise<RenewalOffer> {
  const json = await apiJson(`/api/resman/manager/renewal-offers/${encodeURIComponent(id)}`, config, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
  return CreatedSchema.parse(json).data;
}
