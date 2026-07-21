/**
 * MLGW sync jobs — the Supabase-facing entry points. Port of the persistence
 * half of MLGWClient.syncBills / syncPayments (KrakenCore), with the SwiftData
 * ModelContext replaced by upsertMirror into the mlgw_* mirror tables.
 *
 *   syncMlgwBills:    SSO login → download bills → parse → upsert mlgw_accounts,
 *                     mlgw_bills (+ any payments surfaced during the bill pass).
 *   syncMlgwPayments: SSO login → download payment history → upsert mlgw_payments.
 *
 * NOTE: this port is typecheck-verified only — it has never been run against the
 * live MLGW portal (no credentials/fixtures). The PDF-text seam is unimplemented
 * (download/file-store UnimplementedPdfTextExtractor), so bills whose text comes
 * from a PDF will surface a clear "not implemented" error at runtime.
 */
import { upsertMirror, type ServiceClient } from "../db/client";
import { downloadBillsInBackground, downloadPaymentsInBackground, SupabaseStorageBillFileStore } from "./download";
import type { BillFileStore } from "./download";
import { billSummaries, buildBillDTO, parseDownloadedBills, toAccountRow, toBillRow, toPaymentRow, uniqueParsedBills } from "./parse";
import type { MLGWSyncProperty, MlgwAccountRow, MlgwBillRow, MlgwPaymentRow } from "./types";

export interface MlgwCredentials {
  username: string;
  password: string;
}

export interface SyncMlgwBillsParams {
  supabase: ServiceClient;
  /** Soft ref used as resman_property_id on the mirror rows. */
  propertyId: string;
  propertyName: string;
  credentials: MlgwCredentials;
  workerCount?: number;
  log?: (message: string) => void;
  /** Byte sink for downloaded invoices (default: the `mlgw-bills` storage bucket). */
  fileStore?: BillFileStore;
}

export interface SyncMlgwBillsResult {
  bills: number;
  accounts: number;
  payments: number;
  downloadedDocuments: number;
  skippedKnownDocuments: number;
}

export async function syncMlgwBills(params: SyncMlgwBillsParams): Promise<SyncMlgwBillsResult> {
  const { supabase, propertyId, propertyName, credentials } = params;
  const log = params.log ?? (() => {});
  const property: MLGWSyncProperty = { id: propertyId, name: propertyName };

  const result = await downloadBillsInBackground({
    username: credentials.username,
    password: credentials.password,
    backgroundSyncWorkerCount: params.workerCount,
    progress: log,
    // Persist invoice PDFs to storage so the admin portal can serve them; the
    // in-memory default would silently drop the bytes after the run.
    fileStore: params.fileStore ?? new SupabaseStorageBillFileStore(supabase, undefined, log),
  });

  const parsed = uniqueParsedBills(await parseDownloadedBills(result.downloadedBills));
  const summaries = billSummaries(parsed);

  const accountsById = new Map<string, MlgwAccountRow>();
  const billRows: MlgwBillRow[] = [];
  for (const summary of summaries) {
    const dto = buildBillDTO(summary);
    const accountRow = toAccountRow(dto, property);
    accountsById.set(accountRow.id, accountRow);
    const billRow = toBillRow(dto, property);
    if (billRow !== null) billRows.push(billRow);
  }

  const paymentRows = result.payments
    .map((payment) => toPaymentRow(payment, propertyId))
    .filter((row): row is MlgwPaymentRow => row !== null);

  // Accounts first — mlgw_bills.mlgw_account_id FKs into mlgw_accounts. The typed
  // row shapes are cast to the loose upsert row type at the DB boundary.
  const asRows = (rows: unknown[]): Array<Record<string, unknown>> =>
    rows as Array<Record<string, unknown>>;
  const accountsOut = await upsertMirror(supabase, "mlgw_accounts", asRows([...accountsById.values()]), {
    conflictColumn: "id",
  });
  const billsOut = await upsertMirror(supabase, "mlgw_bills", asRows(billRows), { conflictColumn: "id" });
  const paymentsOut = await upsertMirror(supabase, "mlgw_payments", asRows(paymentRows), {
    conflictColumn: "id",
  });

  log(
    `[mlgw-bills] bills=${billsOut.upserted} accounts=${accountsOut.upserted} payments=${paymentsOut.upserted} ` +
      `downloaded=${result.downloadedDocuments} skippedKnown=${result.skippedKnownDocuments}`,
  );

  return {
    bills: billsOut.upserted,
    accounts: accountsOut.upserted,
    payments: paymentsOut.upserted,
    downloadedDocuments: result.downloadedDocuments,
    skippedKnownDocuments: result.skippedKnownDocuments,
  };
}

export interface SyncMlgwPaymentsParams {
  /** The mirror-write target. Pass `null` (with `dryRun`) to scrape+parse only. */
  supabase: ServiceClient | null;
  propertyId: string;
  credentials: MlgwCredentials;
  workerCount?: number;
  /**
   * Scrape the live portal and parse payment history but write NOTHING — logs
   * the parsed rows for inspection. The safe way to validate this blind port
   * against real data before letting it touch a database. Implied when
   * `supabase` is null.
   */
  dryRun?: boolean;
  log?: (message: string) => void;
}

export interface SyncMlgwPaymentsResult {
  payments: number;
  targets: number;
  dryRun: boolean;
}

export async function syncMlgwPayments(params: SyncMlgwPaymentsParams): Promise<SyncMlgwPaymentsResult> {
  const { supabase, propertyId, credentials } = params;
  const log = params.log ?? (() => {});
  const dryRun = params.dryRun ?? supabase === null;

  const result = await downloadPaymentsInBackground({
    username: credentials.username,
    password: credentials.password,
    backgroundSyncWorkerCount: params.workerCount,
    progress: log,
  });

  const paymentRows = result.payments
    .map((payment) => toPaymentRow(payment, propertyId))
    .filter((row): row is MlgwPaymentRow => row !== null);

  if (dryRun || supabase === null) {
    log(
      `[mlgw-payments] DRY RUN — parsed ${paymentRows.length} payment row(s) from ` +
        `${result.paymentTargets} target(s); nothing written.`,
    );
    // Log a small sample so the parse can be eyeballed against the real portal.
    for (const row of paymentRows.slice(0, 5)) log(`  · ${JSON.stringify(row)}`);
    if (paymentRows.length > 5) log(`  · … and ${paymentRows.length - 5} more`);
    return { payments: paymentRows.length, targets: result.paymentTargets, dryRun: true };
  }

  const out = await upsertMirror(
    supabase,
    "mlgw_payments",
    paymentRows as unknown as Array<Record<string, unknown>>,
    { conflictColumn: "id" },
  );
  log(`[mlgw-payments] payments=${out.upserted} targets=${result.paymentTargets}`);

  return { payments: out.upserted, targets: result.paymentTargets, dryRun: false };
}
