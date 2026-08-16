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
 * Category is the raw ResMan ledger category cell (`l-category-col`). In this
 * property's data it is an accounting CODE — RENTCH, LATECH, WATSCH, ATTYCH,
 * DMG-WVR — not the prose the older comment here claimed. Nothing in the sync
 * enumerates it, so matching is defensive: codes first, then label patterns
 * (see {@link chargeBucketOf}), and the concession/write-off matchers stay
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

/**
 * True when the row belongs to the resident's RENT ledger.
 *
 * ResMan leaves `balance` null on every row it keeps out of the running
 * balance: the security-deposit sub-ledger (deposits are held, not owed),
 * balance transfers, and charge/reversal pairs that cancel to zero. Counting
 * them makes sum(charges − credits) disagree with the running balance on 444
 * of 965 leases; excluding them agrees on 954. Security deposits alone were
 * inflating billed by $160,261 of money nobody owes.
 *
 * This gates MONEY only. It deliberately does NOT gate the eviction filing
 * date — see {@link isLegalFeeEntry}.
 */
export function isRentLedgerEntry(entry: Pick<LedgerSummaryEntry, "balance">): boolean {
  return entry.balance !== null;
}

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

// ---- legal action, read off the ledger -------------------------------------

/**
 * ResMan's ledger category for every eviction-related fee: the court filing
 * fee, the attorney's fee, and service of process. It is a CODE, not free
 * text, which is what makes it trustworthy — unlike the delinquency note,
 * which a leasing agent types by hand and half the time leaves blank.
 *
 * Matching must be on the category and never on the description, because
 * DMG-WVR "Renters Legal Liability Charge" is renter's INSURANCE, carries the
 * word "Legal", and posts monthly on 2,400+ entries across the property.
 */
export const LEGAL_FEE_CATEGORY = "ATTYCH";

/**
 * True for an ATTYCH row that charged the resident for legal action.
 *
 * Requiring charges > 0 drops the negative half of a reversal pair while
 * keeping the original, which is the point: ResMan reverses by posting a
 * matching negative ("Reversed …" / "Reversed to collections …") and
 * annotating the original with a "(Rev 3/10/26)" prefix.
 *
 * NOTE the deliberate asymmetry with {@link isRentLedgerEntry}. A charge that
 * was "reversed to collections" leaves the rent ledger — nobody owes it any
 * more — but the eviction it paid for still happened, and on the very cases
 * that went furthest. Gating filings on the rent ledger would erase 66 of the
 * 151 dated filings, keeping only the ones that never reached write-off. So
 * money is filtered and the EVENT is not.
 */
export function isLegalFeeEntry(
  entry: Pick<LedgerSummaryEntry, "category" | "charges">,
): boolean {
  return entry.category === LEGAL_FEE_CATEGORY && (entry.charges ?? 0) > 0;
}

// ---- what a balance is made of ---------------------------------------------

/**
 * The charge buckets a manager reasons about, in the order they are stacked
 * and keyed. Rent leads because it is 79% of everything owed.
 */
export const CHARGE_BUCKETS = [
  "rent",
  "late",
  "utility",
  "legal",
  "insurance",
  "moveout",
  "other",
] as const;
export type ChargeBucket = (typeof CHARGE_BUCKETS)[number];

/** Dollars of an open balance attributable to each bucket. */
export type BalanceComposition = Record<ChargeBucket, number>;

/**
 * ResMan ledger category CODE → bucket. Codes, not descriptions: the
 * description text carries prorate notes, reversal prefixes and vendor names,
 * while the code is stable.
 */
const BUCKET_BY_CATEGORY: Record<string, ChargeBucket> = {
  RENTCH: "rent",
  MTOMCH: "rent", // month-to-month premium is rent by another name
  PETRCH: "rent",
  SUBSIDYCH: "rent",
  LATECH: "late",
  NSFFCH: "late",
  WATSCH: "utility",
  TRSHCH: "utility",
  PSTCCH: "utility",
  UTIECH: "utility",
  ATTYCH: "legal",
  "DMG-WVR": "insurance",
  LTMFCH: "moveout",
  FORFCH: "moveout",
  CLNGCH: "moveout",
};

/**
 * Label fallbacks for ledger exports that spell the category out instead of
 * coding it ("Rent", "Late Fees", "Attorney's Fees / Court Fees").
 *
 * ORDER MATTERS and insurance must stay ahead of legal: the renter's-insurance
 * line reads "Renters Legal Liability", and a naive /legal/ test files $46k of
 * insurance premiums as eviction costs.
 */
const BUCKET_BY_LABEL: [RegExp, ChargeBucket][] = [
  [/liability|insurance|damage waiver/i, "insurance"],
  [/rent|month.to.month|subsid/i, "rent"],
  [/late|nsf/i, "late"],
  [/water|sewer|trash|pest|electric|utilit/i, "utility"],
  [/attorney|court|process server|eviction/i, "legal"],
  [/termination|forfeit|cleaning|damages/i, "moveout"],
];

/**
 * Ledger category → bucket. The code table wins; the label patterns are a
 * fallback for exports that carry prose. Anything unrecognised is "other",
 * which is drawn and labelled rather than silently dropped.
 */
export function chargeBucketOf(category: string): ChargeBucket {
  const trimmed = category.trim();
  const byCode = BUCKET_BY_CATEGORY[trimmed.toUpperCase()];
  if (byCode) return byCode;
  for (const [pattern, bucket] of BUCKET_BY_LABEL) {
    if (pattern.test(trimmed)) return bucket;
  }
  return "other";
}

function emptyComposition(): BalanceComposition {
  return { rent: 0, late: 0, utility: 0, legal: 0, insurance: 0, moveout: 0, other: 0 };
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
  /**
   * Date of the first legal fee charged AFTER the lease's opening ledger day —
   * the machine's record that an eviction was filed, and the closest thing to
   * a reliable FED-filed date this property has. Null when no filing exists.
   */
  legalFiledDate: string | null;
  /**
   * Gross legal cost this tenancy incurred, in dollars — every positive ATTYCH
   * charge, including ones later reversed to collections, because reversing a
   * charge does not refund the attorney. Distinct from `composition.legal`,
   * which is only the part the resident still owes.
   */
  legalFees: number;
  /**
   * The open balance split by what it was billed FOR, oldest-charge-first.
   * Always sums to `owed`, so a caller can render it as shares of one bar.
   */
  composition: BalanceComposition;
  /**
   * Sum of {@link composition}: what FIFO says is still open, never negative.
   * Matches ResMan's reported balance within a dollar on 907 of 975 leases;
   * where it drifts, treat the composition as the SHAPE of the debt and
   * ResMan's balance as the authority on the total.
   */
  owed: number;
  /** Unapplied credit sitting on the account. Net position is owed − credit. */
  credit: number;
  /** Unpaid rent charges only, for "how many months of rent is this?". */
  rentOwed: number;
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
 *
 * legalFiledDate / legalFees read eviction activity off the ATTYCH category
 * (see {@link isLegalFeeEntry}). This is deliberately the only legal signal
 * the board trusts: 151 leases carry a dated post-migration filing against 64
 * units whose hand-typed delinquency note names any legal stage at all, and 83
 * of those 151 have no note whatsoever. The note wins on exactly one axis — it
 * can say "writ" where the ledger only says "a fee was charged" — so the two
 * are complementary, not redundant.
 *
 * composition / owed / rentOwed apply payments FIFO over the rent ledger:
 * oldest open charge first, which is what the aging columns already assume.
 * Whatever is still open at the end IS the balance, labelled by what it was
 * billed for. Callers should treat the shares as the shape of the debt and
 * ResMan's own balance as the authority on the total.
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
    // A lease with no rent ledger at all — only deposit-sub-ledger rows — has
    // no income statement to state. Emitting a zeroed summary would give it a
    // tenant P&L reading "collected 100% of $0", which is worse than absent.
    // Checked before anything else so a skipped lease is skipped whole.
    const rentRows = rows.filter(isRentLedgerEntry);
    if (rentRows.length === 0) continue;

    let billed = 0;
    let collected = 0;
    let concessions = 0;
    let writeoffs = 0;
    let lastPaymentDate: string | null = null;
    let legalFiledDate: string | null = null;
    let legalFees = 0;

    // The February 2026 ResMan migration opened every existing lease's ledger
    // with one dated batch carrying the balance it arrived with — including,
    // on 48 leases, legal fees billed long before. Those are history, not a
    // filing we can date, so the opening day is excluded outright. Measured
    // over ALL rows, matching the unfiltered scan legal facts run over.
    let openingDay: string | null = null;
    for (const row of rows) {
      if (row.date === null) continue;
      if (openingDay === null || row.date < openingDay) openingDay = row.date;
    }

    // Legal facts run over every row — a filing reversed to collections still
    // happened. See the asymmetry note on isLegalFeeEntry.
    for (const row of rows) {
      if (!isLegalFeeEntry(row) || row.date === null || row.date === openingDay) continue;
      legalFees += row.charges ?? 0;
      if (legalFiledDate === null || row.date < legalFiledDate) legalFiledDate = row.date;
    }

    // Everything below is MONEY, so it runs over the rent ledger only.
    for (const row of rentRows) {
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
    const ordered = [...rentRows].sort((a, b) => {
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

    // FIFO: walk the rent ledger holding a queue of open charges and let each
    // payment retire the oldest ones. Three rules earn their keep:
    //  - a NEGATIVE charge is a reversal, so it cancels the newest matching
    //    charge rather than the oldest;
    //  - an unapplied credit absorbs the very next charge, not merely the next
    //    payment (waiting overstates the debt — it inflated the property's
    //    missing-rent count from 280 months to 335);
    //  - a payment beyond every open charge leaves a credit, which is a credit
    //    balance rather than negative debt.
    const open: { bucket: ChargeBucket; amount: number }[] = [];
    let credit = 0;
    const applyCredit = (amount: number): number => {
      const take = Math.min(credit, amount);
      credit -= take;
      return amount - take;
    };
    for (const row of ordered) {
      const charged = row.charges ?? 0;
      const paid = row.credits ?? 0;
      if (charged > 0) {
        const bucket = chargeBucketOf(row.category);
        const amount = applyCredit(charged);
        if (amount > 0) open.push({ bucket, amount });
      } else if (charged < 0) {
        const bucket = chargeBucketOf(row.category);
        let left = -charged;
        for (let i = open.length - 1; i >= 0 && left > 0; i--) {
          if (open[i].bucket !== bucket) continue;
          const take = Math.min(open[i].amount, left);
          open[i].amount -= take;
          left -= take;
        }
        credit += left;
      }
      if (paid > 0) {
        let left = paid;
        for (const charge of open) {
          if (left <= 0) break;
          const take = Math.min(charge.amount, left);
          charge.amount -= take;
          left -= take;
        }
        credit += left;
      }
    }
    const composition = emptyComposition();
    for (const charge of open) composition[charge.bucket] += charge.amount;
    for (const bucket of CHARGE_BUCKETS) composition[bucket] = round2(composition[bucket]);
    const owed = round2(CHARGE_BUCKETS.reduce((acc, b) => acc + composition[b], 0));

    out.push({
      leaseId,
      billed: round2(billed),
      collected: round2(collected),
      lastPaymentDate,
      firstLateMonth,
      concessions: round2(concessions),
      writeoffs: round2(writeoffs),
      legalFiledDate,
      legalFees: round2(legalFees),
      composition,
      owed,
      credit: round2(credit),
      rentOwed: composition.rent,
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
