import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Monthly owner reports for the manager app. The sync worker's monthly job
 * stores three objects per period in the private `owner-reports` bucket —
 * `<YYYY-MM>.pdf`, `<YYYY-MM>.html`, and `<YYYY-MM>.json` (the FROZEN
 * ReportFigures payload; "report numbers freeze") — and this module reads
 * them back out:
 *
 *   listOwnerReports      — the archive index (newest first, capped at 24),
 *                           each entry carrying a summary parsed from its JSON
 *                           so the phone list renders without extra fetches.
 *   fetchOwnerReportFile  — the PDF bytes for one period, falling back to the
 *                           stored HTML when Chromium was unavailable at
 *                           generation time (the worker stores HTML + JSON
 *                           either way and logs the PDF as pending).
 *
 * There are no table rows — the bucket listing IS the archive index.
 */

export const OWNER_REPORTS_BUCKET = "owner-reports";

/** The phone renders 2 years of archive at most, like the snapshots cap. */
export const REPORT_LIST_CAP = 24;

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Strict "YYYY-MM" with a real month — the only accepted period shape. */
export function isValidReportPeriod(value: string): boolean {
  return PERIOD_RE.test(value);
}

/** Headline fields the manager app's report card + past-reports list render. */
export interface OwnerReportSummary {
  occupancyPct: number | null;
  occupancyMomDeltaPts: number | null;
  collectionsRatePct: number | null;
  collected: number | null;
  billed: number | null;
  balanceTotal: number | null;
  balanceMomDelta: number | null;
  turnsCompleted: number | null;
}

export interface OwnerReportListItem {
  /** "YYYY-MM". */
  period: string;
  /** ISO timestamp recorded at generation, or null on a malformed payload. */
  generatedAt: string | null;
  summary: OwnerReportSummary;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Pull the headline summary out of one frozen ReportFigures JSON. Defensive by
 * design: a malformed payload yields nulls, never a thrown error — one bad
 * archive object must not blank the whole list.
 */
export function parseOwnerReportSummary(json: unknown): {
  generatedAt: string | null;
  summary: OwnerReportSummary;
} {
  const figures = record(json);
  const occupancy = record(figures.occupancy);
  const collections = record(figures.collections);
  const delinquency = record(figures.delinquency);
  const turns = record(figures.turns);
  return {
    generatedAt: typeof figures.generatedAt === "string" ? figures.generatedAt : null,
    summary: {
      occupancyPct: numOrNull(occupancy.pct),
      occupancyMomDeltaPts: numOrNull(occupancy.momDeltaPts),
      collectionsRatePct: numOrNull(collections.ratePct),
      collected: numOrNull(collections.collected),
      billed: numOrNull(collections.billed),
      balanceTotal: numOrNull(delinquency.total),
      balanceMomDelta: numOrNull(delinquency.momDelta),
      turnsCompleted: numOrNull(turns.completed),
    },
  };
}

/**
 * The archive index: every `<YYYY-MM>.json` in the bucket, newest period
 * first, capped at REPORT_LIST_CAP, with each summary parsed from its JSON.
 */
export async function listOwnerReports(): Promise<OwnerReportListItem[]> {
  const storage = createAdminClient().storage.from(OWNER_REPORTS_BUCKET);
  const { data, error } = await storage.list("", {
    limit: 1000,
    sortBy: { column: "name", order: "desc" },
  });
  if (error) {
    console.error("[manager-reports] List error:", error);
    throw new Error("Failed to list owner reports");
  }

  const periods = (data ?? [])
    .map((entry) => entry.name)
    .filter((name): name is string => typeof name === "string" && name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter(isValidReportPeriod)
    .sort()
    .reverse()
    .slice(0, REPORT_LIST_CAP);

  return Promise.all(
    periods.map(async (period): Promise<OwnerReportListItem> => {
      let payload: unknown = null;
      const download = await storage.download(`${period}.json`);
      if (download.error || !download.data) {
        console.error(`[manager-reports] Download error for ${period}.json:`, download.error);
      } else {
        try {
          payload = JSON.parse(await download.data.text());
        } catch (error) {
          console.error(`[manager-reports] Malformed JSON for ${period}:`, error);
        }
      }
      return { period, ...parseOwnerReportSummary(payload) };
    }),
  );
}

export type OwnerReportFileResult =
  | { ok: true; bytes: ArrayBuffer; contentType: "application/pdf" | "text/html"; filename: string }
  | { ok: false; status: number; error: string };

/**
 * The period's report document: the PDF when the worker rendered one, else
 * the stored HTML (Chromium was unavailable; the figures are frozen either
 * way). 404 when the period was never generated.
 */
export async function fetchOwnerReportFile(period: string): Promise<OwnerReportFileResult> {
  if (!isValidReportPeriod(period)) {
    return { ok: false, status: 400, error: "Invalid period" };
  }
  const storage = createAdminClient().storage.from(OWNER_REPORTS_BUCKET);

  const pdf = await storage.download(`${period}.pdf`);
  if (!pdf.error && pdf.data) {
    return {
      ok: true,
      bytes: await pdf.data.arrayBuffer(),
      contentType: "application/pdf",
      filename: `emberly-owner-report-${period}.pdf`,
    };
  }

  const html = await storage.download(`${period}.html`);
  if (!html.error && html.data) {
    return {
      ok: true,
      bytes: await html.data.arrayBuffer(),
      contentType: "text/html",
      filename: `emberly-owner-report-${period}.html`,
    };
  }

  return { ok: false, status: 404, error: "Report not found" };
}
