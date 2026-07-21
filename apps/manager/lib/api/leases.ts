import { z } from "zod";
import { apiJson } from "@/lib/api/client";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * GET /api/resman/manager/leases — the chunky lease mirror for the manager
 * app: every lease from the last 24 months (by application, start, or move-in
 * date) plus anything still current, in ONE payload. The server does no board
 * math; the Pipeline / Expirations / Forecast / Vacancy boards and the Today
 * feed are all derived on device (lib/derived/leasing.ts).
 *
 * status / approvalStatus are free-form ResMan strings on purpose — the sync
 * mirrors whatever ResMan says ("Current", "Notice - Unrented", "Denied", …)
 * and the derived layer matches them defensively, so a widened vocabulary
 * upstream degrades to a fallback bucket in the UI, never a red screen.
 */

const str = z.string().nullable().optional();
const num = z.number().nullable().optional();

export const ManagerLeaseSchema = z.object({
  id: z.string(),
  unitId: str,
  unitNumber: z.string().default(""),
  status: z.string().default(""),
  approvalStatus: z.string().default(""),
  /** All dates are "YYYY-MM-DD" or null. */
  applicationDate: str,
  signedDate: str,
  startDate: str,
  endDate: str,
  moveInDate: str,
  moveOutDate: str,
  leasingAgent: z.string().default(""),
  marketRent: num,
  residentRent: num,
  balance: num,
  isCurrentLease: z.boolean().default(false),
  isMostRecentLease: z.boolean().default(false),
});
export type ManagerLease = z.infer<typeof ManagerLeaseSchema>;

export const ManagerLeaseListSchema = z.object({
  data: z.object({
    leases: z.array(ManagerLeaseSchema),
  }),
});
export type ManagerLeaseList = z.infer<typeof ManagerLeaseListSchema>;

/** Fetch the full manager lease window (no pagination — one chunky payload). */
export async function listManagerLeases(config: StaffConfig): Promise<ManagerLease[]> {
  const json = await apiJson("/api/resman/manager/leases", config);
  return ManagerLeaseListSchema.parse(json).data.leases;
}
