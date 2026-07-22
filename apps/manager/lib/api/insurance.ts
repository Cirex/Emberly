import { z } from "zod";
import { apiJson } from "@/lib/api/client";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * Insurance-compliance feature API: the board feed (one policy row per
 * current lease + the Emberly-owned follow-up trail in one payload) and the
 * action write surface (POST/DELETE /api/resman/manager/insurance-actions).
 * ResMan stays the source of the policy record (resman_lease_insurance) —
 * these action rows only track what Emberly did about each lapse (proof
 * requested → second notice → verified), exactly like the delinquency action
 * timeline. Policy numbers arrive pre-masked (last four characters only);
 * the full number never reaches the device.
 */

const num = z.number().nullable().optional();
const str = z.string().nullable().optional();

/**
 * One current lease with its best policy. All-null policy fields (policyId
 * null) = no policy row at all — the NEVER FILED band.
 */
export const InsurancePolicySchema = z.object({
  leaseId: z.string(),
  unitNumber: z.string().default(""),
  tenantNames: z.array(z.string()).default([]),
  /** "YYYY-MM-DD" move-in (else lease start) — the never-filed context line. */
  leaseStart: str,
  policyId: str,
  provider: str,
  policyNumberLast4: str,
  policyType: str,
  coverageAmount: num,
  startDate: str,
  endDate: str,
});
export type InsurancePolicy = z.infer<typeof InsurancePolicySchema>;

export const INSURANCE_ACTION_KINDS = [
  "proof_requested",
  "second_notice",
  "verified",
  "note",
] as const;
export type InsuranceActionKind = (typeof INSURANCE_ACTION_KINDS)[number];

export const InsuranceActionSchema = z.object({
  id: z.string(),
  resmanLeaseId: z.string(),
  unitNumber: z.string().default(""),
  kind: z.enum(INSURANCE_ACTION_KINDS),
  note: z.string().default(""),
  createdBy: z.string().default(""),
  createdAt: z.string().nullable().optional(),
});
export type InsuranceAction = z.infer<typeof InsuranceActionSchema>;

const BoardSchema = z.object({
  data: z.object({
    policies: z.array(InsurancePolicySchema),
    actions: z.array(InsuranceActionSchema),
  }),
});
export type InsuranceBoardFeed = z.infer<typeof BoardSchema>["data"];

/** The full board feed: per-lease policies + the follow-up trail, one shot. */
export async function fetchInsuranceBoard(config: StaffConfig): Promise<InsuranceBoardFeed> {
  const json = await apiJson("/api/resman/manager/insurance", config);
  return BoardSchema.parse(json).data;
}

export interface InsuranceActionInput {
  resmanLeaseId: string;
  unitNumber?: string;
  kind: InsuranceActionKind;
  note?: string;
}

const CreatedSchema = z.object({ data: InsuranceActionSchema });

/** Record one follow-up action; returns the stored server row. */
export async function createInsuranceAction(
  config: StaffConfig,
  input: InsuranceActionInput,
): Promise<InsuranceAction> {
  const json = await apiJson("/api/resman/manager/insurance-actions", config, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return CreatedSchema.parse(json).data;
}

/** Soft-delete one action (undo for a mistaken log entry). */
export async function deleteInsuranceAction(config: StaffConfig, id: string): Promise<void> {
  await apiJson(`/api/resman/manager/insurance-actions/${encodeURIComponent(id)}`, config, {
    method: "DELETE",
  });
}
