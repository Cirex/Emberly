/**
 * Runnable entry — generate last month's owner report, once.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   bun run sync:owner-report
 *
 * SCHEDULING: this is a MONTHLY job and is deliberately NOT part of sync:all —
 * Coolify schedules `bun run sync:owner-report` as its own cron entry on the
 * 1st of the month, after the nightly pipeline (the report reads the mirror
 * the nightly jobs just refreshed, so "as synced" ≈ month end).
 *
 * Pipeline: figures (src/reports/figures.ts, pure) → HTML template
 * (src/reports/template.ts, pure) → PDF via the SAME Chromium renderer the
 * MLGW bill capture uses (src/mlgw/capture/pdf-renderer.ts) → the private
 * `owner-reports` bucket as <YYYY-MM>.pdf / .html / .json.
 *
 * CHROMIUM UNAVAILABLE: no transcript fallback here (unlike bills). The HTML
 * and the frozen-figures JSON are stored anyway and the run logs clearly that
 * the PDF is pending — a re-run with REPORT_FORCE=1 after Chromium is fixed
 * regenerates all three objects.
 *
 * IDEMPOTENT: if <YYYY-MM>.json already exists the run exits without
 * regenerating ("report numbers freeze" — the archive is an audit trail, not
 * a live view). The JSON is uploaded LAST, so a run that died halfway leaves
 * no marker and the next run regenerates.
 *
 * Optional environment:
 *   REPORT_PERIOD=YYYY-MM  reporting period override (default: previous month)
 *   REPORT_FORCE=1         regenerate even when the period's JSON exists
 *   PROPERTY_TIME_ZONE     IANA zone for "previous month" (default America/Chicago)
 */
import { EMBERLY_PROPERTY_NAME } from "@emberly/core";
import { createServiceClient, type ServiceClient } from "./db/client";
import { createBillPdfRenderer } from "./mlgw/capture";
import {
  buildReportFigures,
  isValidReportPeriod,
  previousCalendarMonth,
  reportPeriodOf,
  trailingMonths,
  type ReportBillRow,
  type ReportDelinquencyActionRow,
  type ReportLeaseRow,
  type ReportPmTaskRow,
  type ReportRenewalOfferRow,
  type ReportSnapshotDayRow,
  type ReportTransactionRow,
  type ReportUnitRow,
  type ReportWorkOrderRow,
} from "./reports/figures";
import { ownerReportExists, ownerReportPaths, uploadOwnerReportObject } from "./reports/store";
import { renderOwnerReportHtml } from "./reports/template";

/** PostgREST caps an unbounded select at 1000 rows; page everything at this size. */
const PAGE = 1000;

/** Page a select through PostgREST's 1000-row window (same as run-snapshots). */
async function readAll<T>(
  supabase: ServiceClient,
  table: string,
  columns: string,
  orderColumn: string,
  refine: (query: any) => any = (q) => q,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await refine(supabase.from(table).select(columns))
      .order(orderColumn, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`read ${table} failed: ${error.message}`);
    const batch = (data ?? []) as unknown as T[];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

/**
 * renewal_offers ships on a separate branch and may not exist yet — a missing
 * table (or any read error) resolves to null so the report simply omits the
 * renewals row instead of failing the whole run. Columns are mapped
 * defensively for the same reason: the block degrades, never throws.
 */
async function readRenewalOffers(supabase: ServiceClient): Promise<ReportRenewalOfferRow[] | null> {
  try {
    const { data, error } = await supabase.from("renewal_offers").select("*").limit(5000);
    if (error) {
      console.warn(`[owner-report] renewal_offers unavailable (${error.message}) — omitting renewals`);
      return null;
    }
    const str = (row: Record<string, unknown>, ...keys: string[]): string | null => {
      for (const key of keys) {
        const value = row[key];
        if (typeof value === "string" && value.trim().length > 0) return value;
      }
      return null;
    };
    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      outcome: str(row, "outcome", "status"),
      sent_at: str(row, "sent_at", "offer_sent_at", "sent_date"),
      responded_at: str(row, "responded_at", "response_at", "resolved_at", "responded_date"),
    }));
  } catch (error) {
    console.warn(
      `[owner-report] renewal_offers unavailable (${error instanceof Error ? error.message : String(error)}) — omitting renewals`,
    );
    return null;
  }
}

async function main(): Promise<void> {
  const env = process.env;
  const supabase = createServiceClient(env);

  const periodKey = env.REPORT_PERIOD?.trim() || previousCalendarMonth(new Date(), env.PROPERTY_TIME_ZONE || undefined);
  if (!isValidReportPeriod(periodKey)) {
    throw new Error(`REPORT_PERIOD must be YYYY-MM, got "${periodKey}"`);
  }
  const period = reportPeriodOf(periodKey);
  const paths = ownerReportPaths(period.period);
  const force = env.REPORT_FORCE === "1";

  if (!force && (await ownerReportExists(supabase, period.period))) {
    console.log(
      `[owner-report] ${paths.json} already exists — figures are frozen; skipping (set REPORT_FORCE=1 to regenerate)`,
    );
    return;
  }

  // Snapshot window: the trailing 12 report months (occupancy series + MoM).
  const seriesStart = `${trailingMonths(period.period, 12)[0]}-01`;

  const workOrderColumns =
    "resman_work_order_id, unit_number, status, priority, is_make_ready, " +
    "date_reported, date_completed, callback_status";

  const [units, leases, transactions, openOrders, completedOrders, bills, pmTasks, actions, snapshots, renewalOffers] =
    await Promise.all([
      readAll<ReportUnitRow>(
        supabase,
        "resman_units",
        "resman_unit_id, number, occupied, holding_unit, excluded_from_occupancy, " +
          "market_rent, lease_rent, balance, current_month_balance, last_month_balance, " +
          "period_balance, previous_balance, delinquency_reason",
        "resman_unit_id",
      ),
      readAll<ReportLeaseRow>(
        supabase,
        "resman_leases",
        "resman_lease_id, unit_number, application_date, signed_date, move_in_date, " +
          "move_out_date, resident_rent, is_current_lease",
        "resman_lease_id",
      ),
      readAll<ReportTransactionRow>(
        supabase,
        "resman_transactions",
        "resman_ledger_entry_id, date, charges, credits",
        "resman_ledger_entry_id",
        (q) => q.gte("date", period.startDate).lte("date", period.endDate),
      ),
      // Turns/maintenance need two slices of the work-order mirror: everything
      // still open, plus everything completed inside the period. Deduped below.
      readAll<ReportWorkOrderRow>(
        supabase,
        "resman_work_orders",
        workOrderColumns,
        "resman_work_order_id",
        (q) => q.not("status", "in", "(Completed,Closed,Canceled)"),
      ),
      readAll<ReportWorkOrderRow>(
        supabase,
        "resman_work_orders",
        workOrderColumns,
        "resman_work_order_id",
        (q) => q.gte("date_completed", period.startDate).lte("date_completed", period.endDate),
      ),
      readAll<ReportBillRow>(
        supabase,
        "mlgw_bills",
        "id, bill_date, amount_due, balance_forward, gas_total, electric_total, " +
          "water_total, sewer_total, other_mlgw_total",
        "id",
        (q) => q.gte("bill_date", period.priorStartDate).lte("bill_date", period.endDate),
      ),
      readAll<ReportPmTaskRow>(
        supabase,
        "pm_tasks",
        "id, round_key, status, due_date, completed_at",
        "id",
        (q) => q.eq("round_key", period.period),
      ),
      readAll<ReportDelinquencyActionRow>(
        supabase,
        "delinquency_actions",
        "id, kind, created_at",
        "id",
        (q) => q.gte("created_at", period.startDate).lt("created_at", period.nextStartDate).is("deleted_at", null),
      ),
      readAll<ReportSnapshotDayRow>(
        supabase,
        "property_snapshots",
        "snapshot_date, occupancy_pct, balance_total, total_units",
        "snapshot_date",
        (q) => q.gte("snapshot_date", seriesStart),
      ),
      readRenewalOffers(supabase),
    ]);

  const workOrdersById = new Map<string, ReportWorkOrderRow>();
  for (const order of [...openOrders, ...completedOrders]) {
    workOrdersById.set(order.resman_work_order_id, order);
  }

  const figures = buildReportFigures({
    period,
    generatedAt: new Date().toISOString(),
    propertyName: EMBERLY_PROPERTY_NAME,
    units,
    leases,
    transactions,
    workOrders: [...workOrdersById.values()],
    bills,
    pmTasks,
    delinquencyActions: actions,
    snapshots,
    renewalOffers,
  });
  const html = renderOwnerReportHtml(figures);

  // The MLGW bill renderer, verbatim (never throws; null = unavailable). Only
  // its log prefix is rewritten so worker logs attribute the lines correctly.
  const renderer = createBillPdfRenderer({
    log: (message) => console.warn(message.replace("[mlgw-bills]", "[owner-report]")),
  });
  let pdf: Uint8Array | null = null;
  try {
    pdf = await renderer.render(html);
  } finally {
    await renderer.close();
  }

  const encoder = new TextEncoder();
  if (pdf !== null) {
    await uploadOwnerReportObject(supabase, paths.pdf, pdf, "application/pdf");
  } else {
    console.warn(
      `[owner-report] PDF PENDING for ${period.period}: Chromium unavailable — storing HTML + figures JSON only. ` +
        `Re-run with REPORT_FORCE=1 once Chromium is installed to produce ${paths.pdf}.`,
    );
  }
  await uploadOwnerReportObject(supabase, paths.html, encoder.encode(html), "text/html");
  // JSON last — its presence is the "report complete" marker (idempotency + the
  // manager list). Frozen at generation time by design.
  await uploadOwnerReportObject(
    supabase,
    paths.json,
    encoder.encode(JSON.stringify(figures, null, 2)),
    "application/json",
  );

  console.log(
    `[owner-report] complete for ${period.period}: ` +
      `${pdf !== null ? `${paths.pdf} (${pdf.byteLength} bytes), ` : "pdf PENDING, "}` +
      `${paths.html}, ${paths.json}`,
  );
}

main().catch((error) => {
  console.error("[owner-report] failed:", error);
  process.exit(1);
});
