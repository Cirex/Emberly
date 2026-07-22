import { z } from "zod";
import { apiJson } from "@/lib/api/client";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * Monthly owner-report archive reads for the Today board's report card and
 * PAST REPORTS band.
 *
 *   GET /api/resman/manager/reports → newest first, capped at 24. Each entry
 *   carries a server-parsed summary (headline fields from the period's FROZEN
 *   figures JSON — "report numbers freeze"), so the phone renders the list
 *   with no per-report fetches.
 *
 * The document itself (PDF, or HTML when Chromium was unavailable at
 * generation) streams from GET /api/resman/manager/reports/<period>; the
 * archive is also always available in the admin portal.
 */

const metric = z.number().nullable().default(null);

export const ReportSummarySchema = z.object({
  occupancyPct: metric,
  occupancyMomDeltaPts: metric,
  collectionsRatePct: metric,
  collected: metric,
  billed: metric,
  balanceTotal: metric,
  balanceMomDelta: metric,
  turnsCompleted: metric,
});
export type ReportSummary = z.infer<typeof ReportSummarySchema>;

export const OwnerReportSchema = z.object({
  /** "YYYY-MM". */
  period: z.string(),
  /** ISO generation timestamp — the freeze moment. */
  generatedAt: z.string().nullable().default(null),
  summary: ReportSummarySchema,
});
export type OwnerReport = z.infer<typeof OwnerReportSchema>;

const EnvelopeSchema = z.object({ data: z.object({ reports: z.array(OwnerReportSchema) }) });

/** The archive index, newest first. Throws ApiError / ZodError; callers contain. */
export async function fetchReports(config: StaffConfig): Promise<OwnerReport[]> {
  const json = await apiJson("/api/resman/manager/reports", config);
  return EnvelopeSchema.parse(json).data.reports;
}
