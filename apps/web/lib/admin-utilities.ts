import type { Database } from "@/types/database";

/**
 * Pure derivations behind /admin/utilities — the XMS utilities dashboard
 * ported to the portal (approved artifact, 2026-07-21). Unlike the manager
 * app's feed (current bills only), the admin page reads the FULL bill history
 * per account, so amount history, the expense ledger, and the ledger tree are
 * exact rather than approximated.
 *
 * Exception thresholds mirror the manager engine
 * (apps/manager/lib/derived/utility-exceptions.ts) so the two surfaces flag
 * the same bills; apps cannot import each other, so the constants are
 * duplicated here with the same names and values. If they drift, consolidate
 * both into @emberly/core.
 *
 * NULL-TOLERANT: per-category totals ride the PDF text-extraction seam and
 * may all be null; everything coalesces to 0 and guards denominators.
 */

type AccountRow = Database["public"]["Tables"]["mlgw_accounts"]["Row"];
type BillRow = Database["public"]["Tables"]["mlgw_bills"]["Row"];
type PaymentRow = Database["public"]["Tables"]["mlgw_payments"]["Row"];

// ---- thresholds (mirrors the manager engine; keep in lockstep) -------------

export const SPIKE_RATIO = 1.75;
export const SPIKE_MIN_AMOUNT = 40;
export const HIGH_ELECTRIC_ABSOLUTE = 150;
export const HIGH_ELECTRIC_RATIO = 1.75;
export const HIGH_ELECTRIC_MIN_AMOUNT = 60;
export const DUE_SOON_DAYS = 7;

// ---- input slices ----------------------------------------------------------

export type UtilityAccount = Pick<
  AccountRow,
  "id" | "account_number" | "service_address" | "unit_number" | "resman_unit_id" | "is_house_account" | "due_now" | "due_date"
>;

export type UtilityBill = Pick<
  BillRow,
  | "id" | "mlgw_account_id" | "document_id" | "is_current" | "bill_date" | "due_date"
  | "amount_due" | "balance_forward" | "bill_for" | "file_path"
  | "gas_total" | "electric_total" | "water_total" | "sewer_total"
  | "other_mlgw_total" | "non_mlgw_total" | "sewer_charge_total"
> &
  Partial<
    Pick<
      BillRow,
      | "street_light_fee_total" | "electrical_late_fee_total" | "security_deposit_total"
      | "smart_meter_connect_charge_total" | "credit_balance_transfer_total" | "share_the_pennies_total"
      | "water_cross_connection_fee_total" | "leasing_outdoor_lighting_total"
      | "mosquito_rodent_control_fee_total" | "storm_water_fee_total" | "solid_waste_fee_total"
    >
  >;

export type UtilityPayment = Pick<
  PaymentRow,
  "id" | "mlgw_account_id" | "reference_number" | "status" | "amount" | "paid_date" | "payment_method" | "authorization_number"
>;

/** The slice of the ResMan unit mirror the occupancy overlay needs. */
export interface UtilityUnitFacts {
  resman_unit_id: string;
  unit_number: string;
  occupancy_status: string | null;
  tenant_names: string[];
  move_in_date: string | null;
  move_out_date: string | null;
  lease_start_date: string | null;
  lease_end_date: string | null;
}

// ---- shared helpers --------------------------------------------------------

const n = (v: number | null | undefined): number => v ?? 0;
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** "YYYY-MM" of an ISO date string, or null. */
export function monthOf(date: string | null): string | null {
  return date && date.length >= 7 ? date.slice(0, 7) : null;
}

/** Water + sewer + the sewer pass-through fee, the mockup's "Water" bucket. */
export function waterTotalOf(bill: UtilityBill): number {
  return n(bill.water_total) + n(bill.sewer_total) + n(bill.sewer_charge_total);
}

/** New charges = amount due minus positive balance forward, floored at 0. */
export function newChargesOf(bill: Pick<UtilityBill, "amount_due" | "balance_forward">): number {
  return Math.max(n(bill.amount_due) - Math.max(n(bill.balance_forward), 0), 0);
}

export interface ChargeSegment {
  key: "balfwd" | "electric" | "water" | "gas" | "other" | "nonmlgw";
  label: string;
  amount: number;
}

/** Nonzero charge segments of a bill, in the mockup's bar order. */
export function chargeSegmentsOf(bill: UtilityBill): ChargeSegment[] {
  const all: ChargeSegment[] = [
    { key: "balfwd", label: "Bal Fwd", amount: Math.max(n(bill.balance_forward), 0) },
    { key: "gas", label: "Gas", amount: n(bill.gas_total) },
    { key: "electric", label: "Elec", amount: n(bill.electric_total) },
    { key: "water", label: "Water", amount: waterTotalOf(bill) },
    { key: "other", label: "Other", amount: n(bill.other_mlgw_total) },
    { key: "nonmlgw", label: "Non-MLGW", amount: n(bill.non_mlgw_total) },
  ];
  return all.filter((s) => s.amount > 0).map((s) => ({ ...s, amount: round2(s.amount) }));
}

export interface FeeItem {
  label: string;
  amount: number;
}

/**
 * The itemized fee lines behind a bill's "Other" charges — XMS's segment
 * popover. Returns nonzero fees plus an "Unclassified" remainder when the
 * other_mlgw_total exceeds the itemized fees (the PDF-extraction seam).
 */
export function feeItemsOf(bill: UtilityBill): FeeItem[] {
  const fees: FeeItem[] = [
    { label: "Street light fee", amount: n(bill.street_light_fee_total) },
    { label: "Electrical late fee", amount: n(bill.electrical_late_fee_total) },
    { label: "Security deposit", amount: n(bill.security_deposit_total) },
    { label: "Smart meter connect", amount: n(bill.smart_meter_connect_charge_total) },
    { label: "Credit balance transfer", amount: n(bill.credit_balance_transfer_total) },
    { label: "Share the Pennies", amount: n(bill.share_the_pennies_total) },
    { label: "Water cross connection", amount: n(bill.water_cross_connection_fee_total) },
    { label: "Outdoor lighting", amount: n(bill.leasing_outdoor_lighting_total) },
    { label: "Mosquito / rodent control", amount: n(bill.mosquito_rodent_control_fee_total) },
    { label: "Storm water fee", amount: n(bill.storm_water_fee_total) },
    { label: "Solid waste fee", amount: n(bill.solid_waste_fee_total) },
  ].filter((f) => f.amount > 0);
  const itemized = fees.reduce((acc, f) => acc + f.amount, 0);
  const remainder = round2(n(bill.other_mlgw_total) - itemized);
  if (remainder > 0.005) fees.push({ label: "Unclassified", amount: remainder });
  return fees.map((f) => ({ ...f, amount: round2(f.amount) }));
}

// ---- monthly series --------------------------------------------------------

export interface MonthPoint {
  month: string; // "YYYY-MM"
  total: number;
  billCount: number;
  /** Per-service sums for the month — the hover callout's breakdown rows. */
  services: Record<"balfwd" | "electric" | "water" | "gas" | "other" | "nonmlgw", number>;
}

/**
 * The last `months` calendar months ENDING at nowMs, every month present
 * (zero-filled) so the chart always draws the full axis like the mockup.
 */
export function monthlySpendSeries(bills: readonly UtilityBill[], nowMs: number, months = 12): MonthPoint[] {
  const keys: string[] = [];
  const now = new Date(nowMs);
  for (let back = months - 1; back >= 0; back--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    keys.push(d.toISOString().slice(0, 7));
  }
  const empty = () => ({
    total: 0,
    billCount: 0,
    services: { balfwd: 0, electric: 0, water: 0, gas: 0, other: 0, nonmlgw: 0 },
  });
  const byMonth = new Map(keys.map((k) => [k, empty()]));
  for (const bill of bills) {
    const month = monthOf(bill.bill_date);
    if (!month) continue;
    const bucket = byMonth.get(month);
    if (!bucket) continue;
    bucket.total += n(bill.amount_due);
    bucket.billCount += 1;
    bucket.services.balfwd += Math.max(n(bill.balance_forward), 0);
    bucket.services.electric += n(bill.electric_total);
    bucket.services.water += waterTotalOf(bill);
    bucket.services.gas += n(bill.gas_total);
    bucket.services.other += n(bill.other_mlgw_total);
    bucket.services.nonmlgw += n(bill.non_mlgw_total);
  }
  return keys.map((month) => {
    const b = byMonth.get(month)!;
    return {
      month,
      total: round2(b.total),
      billCount: b.billCount,
      services: Object.fromEntries(Object.entries(b.services).map(([k, v]) => [k, round2(v)])) as MonthPoint["services"],
    };
  });
}

// ---- current month mix (Units vs House split) ------------------------------

export interface MixGroup {
  billCount: number;
  total: number;
  segments: (ChargeSegment & { share: number })[];
}

export interface CurrentMonthMix {
  month: string | null;
  units: MixGroup;
  house: MixGroup;
}

function buildMixGroup(bills: UtilityBill[]): MixGroup {
  const sums = new Map<ChargeSegment["key"], ChargeSegment>();
  let total = 0;
  for (const bill of bills) {
    total += n(bill.amount_due);
    for (const seg of chargeSegmentsOf(bill)) {
      const cur = sums.get(seg.key);
      if (cur) cur.amount = round2(cur.amount + seg.amount);
      else sums.set(seg.key, { ...seg });
    }
  }
  const segTotal = [...sums.values()].reduce((acc, s) => acc + s.amount, 0);
  const order: ChargeSegment["key"][] = ["balfwd", "gas", "electric", "water", "other", "nonmlgw"];
  return {
    billCount: bills.length,
    total: round2(total),
    segments: order
      .map((key) => sums.get(key))
      .filter((s): s is ChargeSegment => !!s)
      .map((s) => ({ ...s, share: segTotal > 0 ? s.amount / segTotal : 0 })),
  };
}

/** Split the latest month's CURRENT bills by house vs unit accounts. */
export function currentMonthMix(
  accounts: readonly UtilityAccount[],
  bills: readonly UtilityBill[],
): CurrentMonthMix {
  const houseIds = new Set(accounts.filter((a) => a.is_house_account).map((a) => a.id));
  const current = bills.filter((b) => b.is_current);
  const month = current.map((b) => monthOf(b.bill_date)).filter(Boolean).sort().at(-1) ?? null;
  const inMonth = month ? current.filter((b) => monthOf(b.bill_date) === month) : [];
  return {
    month,
    units: buildMixGroup(inMonth.filter((b) => !houseIds.has(b.mlgw_account_id ?? ""))),
    house: buildMixGroup(inMonth.filter((b) => houseIds.has(b.mlgw_account_id ?? ""))),
  };
}

// ---- month over month ------------------------------------------------------

export interface MoMEntry {
  current: number;
  previous: number;
  delta: number;
  /** Null when previous is 0 — "no prior" rather than a fake percent. */
  pct: number | null;
}

export interface MonthOverMonth {
  currentMonth: string | null;
  previousMonth: string | null;
  totalSpend: MoMEntry;
  houseMeters: MoMEntry;
  units: MoMEntry;
  electric: MoMEntry;
  waterSewer: MoMEntry;
  vacancyExposure: { total: number; billCount: number; shareOfSpend: number | null };
  averageMonthlyBill: { average: number; billsPerMonth: number; monthsSpanned: number };
}

function entry(current: number, previous: number): MoMEntry {
  return {
    current: round2(current),
    previous: round2(previous),
    delta: round2(current - previous),
    pct: previous > 0 ? round2(((current - previous) / previous) * 100) : null,
  };
}

export function monthOverMonth(
  accounts: readonly UtilityAccount[],
  bills: readonly UtilityBill[],
  vacantUnitIds: ReadonlySet<string>,
): MonthOverMonth {
  const months = [...new Set(bills.map((b) => monthOf(b.bill_date)).filter((m): m is string => !!m))].sort();
  const currentMonth = months.at(-1) ?? null;
  const previousMonth = months.at(-2) ?? null;
  const houseIds = new Set(accounts.filter((a) => a.is_house_account).map((a) => a.id));
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const inMonth = (m: string | null) => (m ? bills.filter((b) => monthOf(b.bill_date) === m) : []);
  const cur = inMonth(currentMonth);
  const prev = inMonth(previousMonth);
  const sum = (rows: readonly UtilityBill[], f: (b: UtilityBill) => number) => rows.reduce((acc, b) => acc + f(b), 0);
  const houseOf = (rows: readonly UtilityBill[]) => rows.filter((b) => houseIds.has(b.mlgw_account_id ?? ""));
  const unitOf = (rows: readonly UtilityBill[]) => rows.filter((b) => !houseIds.has(b.mlgw_account_id ?? ""));

  const curVacant = cur.filter((b) => {
    const acct = accountById.get(b.mlgw_account_id ?? "");
    return !!acct && !acct.is_house_account && !!acct.resman_unit_id && vacantUnitIds.has(acct.resman_unit_id);
  });
  const curTotal = sum(cur, (b) => n(b.amount_due));
  const vacantTotal = sum(curVacant, (b) => n(b.amount_due));

  const totalAll = sum(bills, (b) => n(b.amount_due));
  const monthsSpanned = months.length;

  return {
    currentMonth,
    previousMonth,
    totalSpend: entry(curTotal, sum(prev, (b) => n(b.amount_due))),
    houseMeters: entry(sum(houseOf(cur), (b) => n(b.amount_due)), sum(houseOf(prev), (b) => n(b.amount_due))),
    units: entry(sum(unitOf(cur), (b) => n(b.amount_due)), sum(unitOf(prev), (b) => n(b.amount_due))),
    electric: entry(sum(cur, (b) => n(b.electric_total)), sum(prev, (b) => n(b.electric_total))),
    waterSewer: entry(sum(cur, waterTotalOf), sum(prev, waterTotalOf)),
    vacancyExposure: {
      total: round2(vacantTotal),
      billCount: curVacant.length,
      shareOfSpend: curTotal > 0 ? round2((vacantTotal / curTotal) * 100) : null,
    },
    averageMonthlyBill: {
      average: monthsSpanned > 0 ? round2(totalAll / monthsSpanned) : 0,
      billsPerMonth: monthsSpanned > 0 ? round2(bills.length / monthsSpanned) : 0,
      monthsSpanned,
    },
  };
}

// ---- account summaries (ledger rows) ---------------------------------------

export interface AccountSummary {
  account: UtilityAccount;
  billCount: number;
  currentBill: UtilityBill | null;
  /** displayDueNow rule from XMS: the account's live dueNow, else the bill's. */
  dueNow: number;
  dueDate: string | null;
  segments: (ChargeSegment & { share: number })[];
  pastDue: boolean;
  dueSoon: boolean;
}

export function accountSummaries(
  accounts: readonly UtilityAccount[],
  bills: readonly UtilityBill[],
  nowMs: number,
): AccountSummary[] {
  const byAccount = new Map<string, UtilityBill[]>();
  for (const bill of bills) {
    const id = bill.mlgw_account_id ?? "";
    const list = byAccount.get(id);
    if (list) list.push(bill);
    else byAccount.set(id, [bill]);
  }
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const soonFloor = new Date(nowMs + DUE_SOON_DAYS * 86400000).toISOString().slice(0, 10);

  return accounts.map((account) => {
    const list = (byAccount.get(account.id) ?? []).slice().sort((a, b) => (b.bill_date ?? "").localeCompare(a.bill_date ?? ""));
    const currentBill = list.find((b) => b.is_current) ?? list[0] ?? null;
    const dueNow = account.due_now ?? n(currentBill?.amount_due);
    const dueDate = account.due_date ?? currentBill?.due_date ?? null;
    const rawSegments = currentBill ? chargeSegmentsOf(currentBill) : [];
    const segTotal = rawSegments.reduce((acc, s) => acc + s.amount, 0);
    return {
      account,
      billCount: list.length,
      currentBill,
      dueNow: round2(dueNow),
      dueDate,
      segments: rawSegments.map((s) => ({ ...s, share: segTotal > 0 ? s.amount / segTotal : 0 })),
      pastDue: dueNow > 0 && !!dueDate && dueDate < today,
      dueSoon: dueNow > 0 && !!dueDate && dueDate >= today && dueDate <= soonFloor,
    };
  });
}

// ---- exceptions (Action Items) ---------------------------------------------

export type ExceptionKind = "high_electrical" | "billed_after_move_in" | "spike";

export interface UtilityException {
  kind: ExceptionKind;
  billId: string;
  accountId: string;
  documentId: string;
  billDate: string | null;
  amount: number;
  /** The metric line, pre-formatted server-side (mockup's orange line). */
  metricLine: string | null;
  reviewed: boolean;
}

const money = (v: number) => `$${v.toFixed(2)}`;

/**
 * XMS's exception scan over CURRENT bills, using true per-account history
 * (unlike the manager app's portfolio approximation):
 *  - high_electrical: unit bill's electric over the absolute threshold, or
 *    HIGH_ELECTRIC_RATIO x the account's own historical electric average.
 *  - spike: new charges >= SPIKE_RATIO x the account's historical average.
 *  - billed_after_move_in: bill dated after the matched unit's move-in.
 */
export function detectExceptions(
  accounts: readonly UtilityAccount[],
  bills: readonly UtilityBill[],
  unitFacts: ReadonlyMap<string, UtilityUnitFacts>,
  reviewedKeys: ReadonlySet<string>, // `${billId}|${kind}`
): UtilityException[] {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const historyByAccount = new Map<string, UtilityBill[]>();
  for (const bill of bills) {
    const id = bill.mlgw_account_id ?? "";
    const list = historyByAccount.get(id);
    if (list) list.push(bill);
    else historyByAccount.set(id, [bill]);
  }

  const out: UtilityException[] = [];
  for (const bill of bills) {
    if (!bill.is_current) continue;
    const account = accountById.get(bill.mlgw_account_id ?? "");
    if (!account) continue;
    const history = (historyByAccount.get(account.id) ?? []).filter((b) => b.id !== bill.id && !b.is_current);
    const histAvg = history.length > 0 ? history.reduce((acc, b) => acc + newChargesOf(b), 0) / history.length : null;
    const histElecAvg =
      history.length > 0 ? history.reduce((acc, b) => acc + n(b.electric_total), 0) / history.length : null;

    const push = (kind: ExceptionKind, amount: number, metricLine: string | null) =>
      out.push({
        kind,
        billId: bill.id,
        accountId: account.id,
        documentId: bill.document_id,
        billDate: bill.bill_date,
        amount: round2(amount),
        metricLine,
        reviewed: reviewedKeys.has(`${bill.id}|${kind}`),
      });

    // High electrical — unit accounts only (house meters are structurally big).
    const elec = n(bill.electric_total);
    if (!account.is_house_account && elec > 0) {
      const overAbsolute = elec >= HIGH_ELECTRIC_ABSOLUTE;
      const overRelative =
        histElecAvg !== null && histElecAvg > 0 && elec >= histElecAvg * HIGH_ELECTRIC_RATIO && elec >= HIGH_ELECTRIC_MIN_AMOUNT;
      if (overAbsolute || overRelative) {
        const newCharges = newChargesOf(bill);
        const vs = histAvg !== null && histAvg > 0
          ? `New charges ${money(newCharges)} vs avg ${money(histAvg)} (${newCharges >= histAvg ? "+" : "−"}${money(Math.abs(newCharges - histAvg))}, ${histAvg > 0 ? `${newCharges >= histAvg ? "+" : "−"}${Math.abs(((newCharges - histAvg) / histAvg) * 100).toFixed(1)}%` : "—"}) — `
          : "";
        push("high_electrical", elec, `${vs}Electric ${money(elec)} vs threshold ${money(HIGH_ELECTRIC_ABSOLUTE)}`);
      }
    }

    // Spike — unit accounts with enough history.
    if (!account.is_house_account && histAvg !== null && histAvg > 0) {
      const newCharges = newChargesOf(bill);
      if (newCharges >= histAvg * SPIKE_RATIO && newCharges >= SPIKE_MIN_AMOUNT) {
        push(
          "spike",
          newCharges,
          `New charges ${money(newCharges)} vs avg ${money(histAvg)} (+${money(newCharges - histAvg)}, +${(((newCharges - histAvg) / histAvg) * 100).toFixed(1)}%)`,
        );
      }
    }

    // Billed after move-in — the matched unit is occupied and the bill lands
    // after the tenant's move-in date.
    const facts = account.resman_unit_id ? unitFacts.get(account.resman_unit_id) : undefined;
    if (facts?.move_in_date && bill.bill_date && bill.bill_date > facts.move_in_date && !account.is_house_account) {
      if (!facts.move_out_date || facts.move_out_date > bill.bill_date) {
        push("billed_after_move_in", n(bill.amount_due), null);
      }
    }
  }

  // Unreviewed first, then by amount descending — the mockup's ordering.
  return out.sort((a, b) => Number(a.reviewed) - Number(b.reviewed) || b.amount - a.amount);
}

// ---- bill detail -----------------------------------------------------------

export interface LedgerTreeNode {
  bill: UtilityBill;
  newCharges: number;
  /** Payments dated on/after this bill and before the next newer bill. */
  payments: UtilityPayment[];
  paidBeforeNext: number;
  /** True when the payments equal the NEXT bill's balance forward story:
   *  next.balance_forward === max(bill.amount_due - paidBeforeNext, 0). */
  reconciles: boolean | null;
  isLatest: boolean;
}

/** Newest-first bill/payment interleave with balance-forward reconciliation. */
export function buildLedgerTree(bills: readonly UtilityBill[], payments: readonly UtilityPayment[]): LedgerTreeNode[] {
  const sorted = bills.slice().sort((a, b) => (b.bill_date ?? "").localeCompare(a.bill_date ?? ""));
  const pays = payments.slice().sort((a, b) => (a.paid_date ?? "").localeCompare(b.paid_date ?? ""));
  return sorted.map((bill, i) => {
    const nextNewer = sorted[i - 1];
    const from = bill.bill_date ?? "";
    const to = nextNewer?.bill_date ?? "9999-12-31";
    const slice = pays.filter((p) => (p.paid_date ?? "") >= from && (p.paid_date ?? "") < to);
    const paid = slice.reduce((acc, p) => acc + n(p.amount), 0);
    const expectedForward = Math.max(n(bill.amount_due) - paid, 0);
    return {
      bill,
      newCharges: round2(newChargesOf(bill)),
      payments: slice,
      paidBeforeNext: round2(paid),
      reconciles: nextNewer ? Math.abs(n(nextNewer.balance_forward) - expectedForward) < 0.005 : null,
      isLatest: i === 0,
    };
  });
}

export interface BillDetailStats {
  average: number | null;
  amountRecords: number;
  highest: { amount: number; billDate: string | null } | null;
  /** Current minus previous bill amount; null without a previous. */
  previousDelta: { delta: number; previousDate: string | null } | null;
  afterMoveIn: { total: number; billCount: number; since: string } | null;
  /** Post-move-in bills still carrying a balance forward (the XMS second alert). */
  afterMoveInBalanceForward: { total: number; billCount: number; since: string } | null;
}

export function billDetailStats(
  bills: readonly UtilityBill[],
  current: UtilityBill,
  facts: UtilityUnitFacts | null,
): BillDetailStats {
  const dated = bills.filter((b) => b.amount_due !== null);
  const amounts = dated.map((b) => n(b.amount_due));
  const average = amounts.length > 0 ? round2(amounts.reduce((a, b) => a + b, 0) / amounts.length) : null;
  const highest = dated.slice().sort((a, b) => n(b.amount_due) - n(a.amount_due))[0] ?? null;
  const sorted = bills.slice().sort((a, b) => (b.bill_date ?? "").localeCompare(a.bill_date ?? ""));
  const idx = sorted.findIndex((b) => b.id === current.id);
  const previous = idx >= 0 ? sorted[idx + 1] : undefined;
  const after =
    facts?.move_in_date
      ? bills.filter((b) => b.bill_date && b.bill_date > facts.move_in_date! && (!facts.move_out_date || facts.move_out_date > b.bill_date))
      : [];
  return {
    average,
    amountRecords: amounts.length,
    highest: highest ? { amount: round2(n(highest.amount_due)), billDate: highest.bill_date } : null,
    previousDelta:
      previous && previous.amount_due !== null
        ? { delta: round2(n(current.amount_due) - n(previous.amount_due)), previousDate: previous.bill_date }
        : null,
    afterMoveIn:
      after.length > 0
        ? { total: round2(after.reduce((acc, b) => acc + n(b.amount_due), 0)), billCount: after.length, since: facts!.move_in_date! }
        : null,
    afterMoveInBalanceForward: (() => {
      const carrying = after.filter((b) => n(b.balance_forward) > 0);
      return carrying.length > 0
        ? {
            total: round2(carrying.reduce((acc, b) => acc + n(b.balance_forward), 0)),
            billCount: carrying.length,
            since: facts!.move_in_date!,
          }
        : null;
    })(),
  };
}
