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
import {
  billSummaries,
  buildBillDTO,
  buildUnitLookup,
  parseDownloadedBills,
  resolveAccountUnit,
  toAccountRow,
  toBillRow,
  toPaymentRow,
  uniqueParsedBills,
  type PropertyUnitInput,
} from "./parse";
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
  /** Unit-matcher inputs (default: the property's resman_units mirror rows). */
  units?: PropertyUnitInput[];
}

export interface SyncMlgwBillsResult {
  bills: number;
  accounts: number;
  payments: number;
  downloadedDocuments: number;
  skippedKnownDocuments: number;
}

/**
 * Digits-only account number → account id, for payment FK linkage (the Swift
 * importer linked payments to accounts by normalized account number; the TS
 * port left it to the job layer). Ambiguous numbers are dropped rather than
 * guessed, mirroring the unit matcher's unique-bucket discipline.
 */
export function accountIdByNormalizedNumber(
  accounts: Array<{ id: string; account_number: string | null }>,
): Map<string, string> {
  const idByNumber = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const account of accounts) {
    const key = (account.account_number ?? "").replace(/[^0-9]/g, "");
    if (key.length === 0) continue;
    if (idByNumber.has(key) && idByNumber.get(key) !== account.id) ambiguous.add(key);
    else idByNumber.set(key, account.id);
  }
  for (const key of ambiguous) idByNumber.delete(key);
  return idByNumber;
}

/** Set `mlgw_account_id` on rows whose account number resolves; returns the linked count. */
export function linkPaymentRowsToAccounts(
  rows: MlgwPaymentRow[],
  idByNumber: Map<string, string>,
): number {
  let linked = 0;
  for (const row of rows) {
    const key = (row.account_number ?? "").replace(/[^0-9]/g, "");
    const id = key.length > 0 ? idByNumber.get(key) : undefined;
    if (id !== undefined) {
      row.mlgw_account_id = id;
      linked += 1;
    }
  }
  return linked;
}

/** The property's persisted account rows, for payment linkage in the payments job. */
async function fetchAccountLinkageRows(
  supabase: ServiceClient,
  propertyId: string,
): Promise<Array<{ id: string; account_number: string | null }>> {
  const PAGE = 1000;
  const rows: Array<{ id: string; account_number: string | null }> = [];
  for (let from = 0; ; from += PAGE) {
    const res = await supabase
      .from("mlgw_accounts")
      .select("id, account_number")
      .eq("resman_property_id", propertyId)
      .order("id")
      .range(from, from + PAGE - 1);
    if (res.error) throw new Error(`mlgw_accounts read failed: ${res.error.message}`);
    const page = (res.data ?? []) as Array<{ id: string; account_number: string | null }>;
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

/** The property's resman_units mirror rows, shaped for `buildUnitLookup`. */
async function fetchPropertyUnits(supabase: ServiceClient, propertyId: string): Promise<PropertyUnitInput[]> {
  const PAGE = 1000;
  const units: PropertyUnitInput[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await supabase
      .from("resman_units")
      .select("resman_unit_id, number, street, city, state")
      .eq("resman_property_id", propertyId)
      .order("resman_unit_id")
      .range(from, from + PAGE - 1);
    if (res.error) throw new Error(`resman_units read failed: ${res.error.message}`);
    const rows = (res.data ?? []) as Array<{
      resman_unit_id: string;
      number: string | null;
      street: string | null;
      city: string | null;
      state: string | null;
    }>;
    for (const row of rows) {
      units.push({
        unitId: row.resman_unit_id,
        number: row.number ?? "",
        street: row.street ?? "",
        city: row.city ?? "",
        state: row.state ?? "",
      });
    }
    if (rows.length < PAGE) return units;
  }
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

  // Account → unit linkage (XMS's address heuristic): built from the property's
  // resman_units mirror so vacancy exposure / occupancy overlays have real ids.
  const units = params.units ?? (await fetchPropertyUnits(supabase, propertyId));
  const unitLookup = buildUnitLookup(units);

  const accountsById = new Map<string, MlgwAccountRow>();
  const billRows: MlgwBillRow[] = [];
  for (const summary of summaries) {
    const dto = buildBillDTO(summary);
    const resolved = resolveAccountUnit(dto.servicesAt ?? "", unitLookup);
    const accountRow = toAccountRow(dto, property, resolved.resman_unit_id ? resolved : undefined);
    accountsById.set(accountRow.id, accountRow);
    const billRow = toBillRow(dto, property);
    if (billRow !== null) billRows.push(billRow);
  }

  const paymentRows = result.payments
    .map((payment) => toPaymentRow(payment, propertyId))
    .filter((row): row is MlgwPaymentRow => row !== null);
  linkPaymentRowsToAccounts(paymentRows, accountIdByNormalizedNumber([...accountsById.values()]));

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

  const linkage = accountIdByNormalizedNumber(await fetchAccountLinkageRows(supabase, propertyId));
  const linked = linkPaymentRowsToAccounts(paymentRows, linkage);

  const out = await upsertMirror(
    supabase,
    "mlgw_payments",
    paymentRows as unknown as Array<Record<string, unknown>>,
    { conflictColumn: "id" },
  );
  log(`[mlgw-payments] payments=${out.upserted} linked=${linked} targets=${result.paymentTargets}`);

  return { payments: out.upserted, targets: result.paymentTargets, dryRun: false };
}
