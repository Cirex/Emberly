import { z } from "zod";
import { apiJson } from "@/lib/api/client";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * MLGW (utility) feed for the Utilities board. One chunky read —
 * GET /api/resman/manager/mlgw — returns accounts with current dues, each
 * account's current bill(s) with charge-category totals, a 12-month spend
 * series, and the exception-review checklist. The only write is the reviewed
 * toggle (POST /api/resman/manager/mlgw-reviews).
 *
 * DATA CAVEAT: the per-category charge totals come from the bill-PDF text
 * extraction seam, which is unfinished in production — every one of those
 * fields may be null or zero. Consumers must degrade to amountDue-only
 * rendering (see lib/derived/utility-exceptions.ts), never NaN.
 */

const num = z.number().nullable().optional();
const str = z.string().nullable().optional();

export const MlgwAccountSchema = z.object({
  id: z.string(),
  accountNumber: z.string().default(""),
  serviceAddress: z.string().default(""),
  unitNumber: z.string().default(""),
  isHouseAccount: z.boolean().default(false),
  dueNow: num,
  dueDate: str,
});
export type MlgwAccount = z.infer<typeof MlgwAccountSchema>;

export const MlgwCurrentBillSchema = z.object({
  id: z.string(),
  accountId: str,
  billDate: str,
  dueDate: str,
  amountDue: num,
  balanceForward: num,
  gasTotal: num,
  electricTotal: num,
  waterTotal: num,
  sewerTotal: num,
  otherMlgwTotal: num,
  nonMlgwTotal: num,
  streetLightFeeTotal: num,
  electricalLateFeeTotal: num,
  securityDepositTotal: num,
  smartMeterConnectChargeTotal: num,
  creditBalanceTransferTotal: num,
  shareThePenniesTotal: num,
  waterCrossConnectionFeeTotal: num,
  leasingOutdoorLightingTotal: num,
  mosquitoRodentControlFeeTotal: num,
  sewerChargeTotal: num,
  stormWaterFeeTotal: num,
  solidWasteFeeTotal: num,
});
export type MlgwCurrentBill = z.infer<typeof MlgwCurrentBillSchema>;

export const MlgwMonthlyTotalSchema = z.object({
  /** "YYYY-MM", ascending; months with no bills are omitted by the server. */
  month: z.string(),
  total: z.number(),
  billCount: z.number(),
});
export type MlgwMonthlyTotal = z.infer<typeof MlgwMonthlyTotalSchema>;

export const MlgwReviewSchema = z.object({
  id: z.string(),
  billId: z.string(),
  accountNumber: z.string().default(""),
  exceptionKind: z.string(),
  reviewedAt: str,
});
export type MlgwReview = z.infer<typeof MlgwReviewSchema>;

export const ManagerMlgwPayloadSchema = z.object({
  accounts: z.array(MlgwAccountSchema),
  currentBills: z.array(MlgwCurrentBillSchema),
  monthlyTotals: z.array(MlgwMonthlyTotalSchema),
  reviews: z.array(MlgwReviewSchema),
});
export type ManagerMlgwPayload = z.infer<typeof ManagerMlgwPayloadSchema>;

const EnvelopeSchema = z.object({ data: ManagerMlgwPayloadSchema });

/** Fetch the whole MLGW surface. Throws ApiError / ZodError; callers contain. */
export async function fetchManagerMlgw(config: StaffConfig): Promise<ManagerMlgwPayload> {
  const json = await apiJson("/api/resman/manager/mlgw", config);
  return EnvelopeSchema.parse(json).data;
}

export interface MlgwReviewInput {
  billId: string;
  accountNumber?: string;
  exceptionKind: string;
  reviewed: boolean;
}

const ReviewResultSchema = z.object({ data: z.object({ reviewed: z.boolean() }) });

/** Toggle one exception's reviewed checkbox. Returns the server's final state. */
export async function setMlgwReviewed(
  input: MlgwReviewInput,
  config: StaffConfig,
): Promise<boolean> {
  const json = await apiJson("/api/resman/manager/mlgw-reviews", config, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return ReviewResultSchema.parse(json).data.reviewed;
}
