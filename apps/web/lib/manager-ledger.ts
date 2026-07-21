import type { Database } from "@/types/database";
import type { UntypedSupabase } from "@/lib/supabase/types";

/**
 * Ledger reads for the manager app, aggregated from resman_transactions (the
 * per-lease ResMan ledger mirror; see supabase/sync/src/resman/scrapers/ledger.ts).
 *
 * No raw-SQL RPC is available and PostgREST grouping is too limited for these
 * shapes, so the summary aggregates in JS over a paged select of only the
 * needed columns, capped at LEDGER_MAX_ROWS. The aggregation itself is a pure
 * exported function so tests exercise it without a database.
 *
 * Category is the raw ResMan ledger category cell (`l-category-col`) — free
 * text like "Rent", "Late Fees", "Concession", "Write Off"; there is no
 * enumerated list in the sync, so the concession/write-off matchers are
 * substring regexes over category OR ledger_description.
 */

type TransactionRow = Database["public"]["Tables"]["resman_transactions"]["Row"];

/** The resman_transactions columns the summary aggregation needs. */
export const LEDGER_SUMMARY_COLUMNS =
  "resman_lease_id, date, category, ledger_description, charges, credits, balance, ledger_sequence";

export type LedgerSummaryEntry = Pick<
  TransactionRow,
  | "resman_lease_id"
  | "date"
  | "category"
  | "ledger_description"
  | "charges"
  | "credits"
  | "balance"
  | "ledger_sequence"
>;

/** Paging knobs for the summary fetch. */
export const LEDGER_PAGE_SIZE = 1000;
export const LEDGER_MAX_ROWS = 50_000;

/** A month-end running balance above this reads as "late" (small credits
 *  and rounding dust below it do not). */
export const LATE_BALANCE_THRESHOLD = 50;

const CONCESSION_RE = /concession/i;
const WRITEOFF_RE = /write[\s-]?off/i;

/** True when the entry's category or description mentions a concession. */
export function isConcessionEntry(
  entry: Pick<LedgerSummaryEntry, "category" | "ledger_description">,
): boolean {
  return CONCESSION_RE.test(entry.category) || CONCESSION_RE.test(entry.ledger_description);
}

/** True for "writeoff" / "write off" / "write-off" in category or description. */
export function isWriteoffEntry(
  entry: Pick<LedgerSummaryEntry, "category" | "ledger_description">,
): boolean {
  return WRITEOFF_RE.test(entry.category) || WRITEOFF_RE.test(entry.ledger_description);
}

/** One-row-per-lease ledger aggregate, camelCased for the wire. */
export interface LeaseLedgerSummary {
  leaseId: string;
  /** Sum of charges. */
  billed: number;
  /** Sum of credits. */
  collected: number;
  /** Max entry date carrying credits > 0. */
  lastPaymentDate: string | null;
  /** Earliest "YYYY-MM" whose month-end running balance exceeded the threshold. */
  firstLateMonth: string | null;
  /** Net concession value: credits minus charges over concession-matched entries. */
  concessions: number;
  /** Net write-off value: credits minus charges over write-off-matched entries. */
  writeoffs: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Pure per-lease aggregation. firstLateMonth walks each lease's entries in
 * ledger order (date, then ledger_sequence — the scraper's running-balance
 * order within a day), takes the last non-null running balance seen in each
 * month as that month's month-end balance, and reports the earliest month
 * whose month-end balance exceeds LATE_BALANCE_THRESHOLD. Entries without a
 * date or lease are skipped. Output is ordered by leaseId.
 */
export function summarizeLedgerEntries(entries: readonly LedgerSummaryEntry[]): LeaseLedgerSummary[] {
  const byLease = new Map<string, LedgerSummaryEntry[]>();
  for (const entry of entries) {
    if (!entry.resman_lease_id) continue;
    const list = byLease.get(entry.resman_lease_id);
    if (list) list.push(entry);
    else byLease.set(entry.resman_lease_id, [entry]);
  }

  const out: LeaseLedgerSummary[] = [];
  for (const leaseId of [...byLease.keys()].sort()) {
    const rows = byLease.get(leaseId) ?? [];
    let billed = 0;
    let collected = 0;
    let concessions = 0;
    let writeoffs = 0;
    let lastPaymentDate: string | null = null;

    for (const row of rows) {
      billed += row.charges ?? 0;
      collected += row.credits ?? 0;
      const net = (row.credits ?? 0) - (row.charges ?? 0);
      if (isConcessionEntry(row)) concessions += net;
      if (isWriteoffEntry(row)) writeoffs += net;
      if ((row.credits ?? 0) > 0 && row.date !== null) {
        if (lastPaymentDate === null || row.date > lastPaymentDate) lastPaymentDate = row.date;
      }
    }

    // Month-end balances in ledger order; later entries overwrite earlier ones
    // within a month, so the map ends holding each month's closing balance.
    const ordered = [...rows].sort((a, b) => {
      const dateCmp = (a.date ?? "").localeCompare(b.date ?? "");
      if (dateCmp !== 0) return dateCmp;
      return (a.ledger_sequence ?? 0) - (b.ledger_sequence ?? 0);
    });
    const monthEnd = new Map<string, number>();
    for (const row of ordered) {
      if (row.date === null || row.balance === null) continue;
      monthEnd.set(row.date.slice(0, 7), row.balance);
    }
    let firstLateMonth: string | null = null;
    for (const month of [...monthEnd.keys()].sort()) {
      if ((monthEnd.get(month) ?? 0) > LATE_BALANCE_THRESHOLD) {
        firstLateMonth = month;
        break;
      }
    }

    out.push({
      leaseId,
      billed: round2(billed),
      collected: round2(collected),
      lastPaymentDate,
      firstLateMonth,
      concessions: round2(concessions),
      writeoffs: round2(writeoffs),
    });
  }
  return out;
}

/**
 * All lease-linked transactions' summary columns, paged by primary key so no
 * page shears, capped at LEDGER_MAX_ROWS.
 */
export async function fetchLedgerSummaryEntries(client: UntypedSupabase): Promise<LedgerSummaryEntry[]> {
  const out: LedgerSummaryEntry[] = [];
  for (let from = 0; from < LEDGER_MAX_ROWS; from += LEDGER_PAGE_SIZE) {
    const { data, error } = await client
      .from("resman_transactions")
      .select(LEDGER_SUMMARY_COLUMNS)
      .not("resman_lease_id", "is", null)
      .order("resman_ledger_entry_id", { ascending: true })
      .range(from, Math.min(from + LEDGER_PAGE_SIZE, LEDGER_MAX_ROWS) - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as LedgerSummaryEntry[];
    out.push(...rows);
    if (rows.length < LEDGER_PAGE_SIZE) break;
  }
  return out;
}

// ---- per-lease ledger (drill-in) -------------------------------------------

export const LEDGER_ENTRY_LIMIT = 500;

/** The resman_transactions columns the drill-in payload carries. */
export const LEDGER_ENTRY_COLUMNS =
  "resman_ledger_entry_id, date, transaction_type, category, ledger_description, charges, credits, balance";

export type LedgerEntryRow = Pick<
  TransactionRow,
  | "resman_ledger_entry_id"
  | "date"
  | "transaction_type"
  | "category"
  | "ledger_description"
  | "charges"
  | "credits"
  | "balance"
>;

/** One ledger entry, camelCased for the wire. */
export interface LedgerEntryPayload {
  id: string;
  date: string | null;
  transactionType: string;
  category: string;
  description: string;
  charges: number | null;
  credits: number | null;
  balance: number | null;
}

export function ledgerEntryPayload(row: LedgerEntryRow): LedgerEntryPayload {
  return {
    id: row.resman_ledger_entry_id,
    date: row.date,
    transactionType: row.transaction_type,
    category: row.category,
    description: row.ledger_description,
    charges: row.charges,
    credits: row.credits,
    balance: row.balance,
  };
}

/** One lease's ledger, newest first (date, then intra-day sequence), capped. */
export async function listLeaseLedger(
  client: UntypedSupabase,
  leaseId: string,
): Promise<LedgerEntryPayload[]> {
  const { data, error } = await client
    .from("resman_transactions")
    .select(LEDGER_ENTRY_COLUMNS)
    .eq("resman_lease_id", leaseId)
    .order("date", { ascending: false })
    .order("ledger_sequence", { ascending: false })
    .limit(LEDGER_ENTRY_LIMIT);
  if (error) throw new Error(error.message);
  return ((data ?? []) as LedgerEntryRow[]).map(ledgerEntryPayload);
}
