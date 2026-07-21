import type {
  MlgwAccount,
  MlgwCurrentBill,
  MlgwMonthlyTotal,
  MlgwReview,
} from "@/lib/api/mlgw";

/**
 * The utility exception engine — a pure port of the XMS utilities concept:
 * scan every current bill and flag the ones a manager should look at, with an
 * action line and a priority, matched against the persisted reviewed
 * checklist (mlgw_exception_reviews, keyed billId + kind).
 *
 * PURE ON PURPOSE: no React, no stores, no i18n imports. All display copy is
 * produced through the injected `ExceptionCopy` callbacks so the screen can
 * route it through i18next while tests pass a trivial English stub. All date
 * comparisons are lexicographic on ISO "YYYY-MM-DD" prefixes.
 *
 * NULL-TOLERANT ON PURPOSE: the per-category charge totals ride the bill-PDF
 * text-extraction seam, which is unfinished in production — any of them may be
 * null or zero. Every computation coalesces null to 0 and every ratio guards
 * its denominator, so the engine (and everything drawn from it) degrades to
 * amountDue-only output rather than NaN.
 *
 * HISTORY APPROXIMATION: the feed carries only each account's CURRENT bill(s);
 * true per-account history is not available. The "historical average" used by
 * the spike rule is therefore approximated from `monthlyTotals` (portfolio
 * total ÷ bill count per month) over the months BEFORE the current one — i.e.
 * the portfolio-wide average charge per bill. That makes 'spike' a
 * "well above a typical bill here" signal rather than a strict per-account
 * delta, which is why it (and 'high_electrical') only apply to unit accounts:
 * house/master meters are structurally larger than the per-bill average and
 * would always misfire.
 */

// ---- thresholds (documented constants, exported for tests) -----------------

/** Spike when current charges >= this multiple of the typical bill. */
export const SPIKE_RATIO = 1.75;
/** ...and at least this many dollars, so tiny bills never flag. */
export const SPIKE_MIN_AMOUNT = 40;
/** High electrical: absolute threshold that always flags. */
export const HIGH_ELECTRIC_ABSOLUTE = 150;
/** High electrical: relative multiple of the portfolio's typical electric. */
export const HIGH_ELECTRIC_RATIO = 1.75;
/** ...with a floor so the relative rule ignores trivial charges. */
export const HIGH_ELECTRIC_MIN_AMOUNT = 60;
/** A month is drawn "hot" when its total >= this multiple of the average. */
export const MONTH_HOT_RATIO = 1.35;
/** Payables "due soon" horizon, days. */
export const DUE_SOON_DAYS = 7;

export type UtilityExceptionKind =
  | "spike"
  | "high_electrical"
  | "billed_after_move_in"
  | "balance_forward"
  | "fee_spike"
  | "past_due";

/** Sort order: lower = more urgent. */
export const EXCEPTION_PRIORITY: Record<UtilityExceptionKind, number> = {
  spike: 1,
  billed_after_move_in: 2,
  high_electrical: 3,
  past_due: 4,
  fee_spike: 5,
  balance_forward: 6,
};

/** The fee columns the fee_spike rule watches (non-routine one-off charges). */
export const FEE_FIELDS = [
  ["electricalLateFeeTotal", "electrical_late"],
  ["smartMeterConnectChargeTotal", "smart_meter"],
  ["waterCrossConnectionFeeTotal", "water_cross_connection"],
  ["securityDepositTotal", "security_deposit"],
] as const satisfies readonly (readonly [keyof MlgwCurrentBill, string])[];

export type FeeKey = (typeof FEE_FIELDS)[number][1];

// ---- shapes ----------------------------------------------------------------

/** Everything a copy callback might need to phrase the row. Raw values — the
 *  caller formats (and localizes) them. */
export interface ExceptionContext {
  amount: number;
  typical?: number;
  billDate?: string | null;
  dueDate?: string | null;
  moveInDate?: string | null;
  balanceForward?: number;
  feeKey?: FeeKey;
}

/** Injected display-copy seam — the screen backs this with i18next. */
export interface ExceptionCopy {
  title: (kind: UtilityExceptionKind) => string;
  action: (kind: UtilityExceptionKind) => string;
  detail: (kind: UtilityExceptionKind, ctx: ExceptionContext) => string;
}

export interface UtilityException {
  billId: string;
  accountNumber: string;
  /** "" for house accounts. */
  unitNumber: string;
  isHouseAccount: boolean;
  kind: UtilityExceptionKind;
  title: string;
  action: string;
  detail: string;
  /** The flagged dollar amount (charge, fee, or balance — per kind). */
  amount: number;
  priority: number;
  /** The raw values behind `detail`, for callers that need one of them. */
  context: ExceptionContext;
  /** `${billId}|${kind}` — the reviews checklist's natural key tail. */
  reviewedKey: string;
  reviewed: boolean;
}

/** The slice of a ResMan unit the move-in rule needs (from useUnits().allUnits). */
export interface UnitMoveIn {
  unitNumber: string;
  moveInDate: string | null | undefined;
}

export interface UtilityExceptionInput {
  accounts: MlgwAccount[];
  currentBills: MlgwCurrentBill[];
  monthlyTotals: MlgwMonthlyTotal[];
  reviews: MlgwReview[];
  units: UnitMoveIn[];
  /** "YYYY-MM-DD" — injected for purity. */
  nowIso: string;
}

// ---- helpers ---------------------------------------------------------------

const n = (v: number | null | undefined): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

const day = (iso: string | null | undefined): string => (iso ?? "").slice(0, 10);

/** Unit numbers as stored by MLGW ("0644") vs ResMan may differ in leading
 *  zeros/case — normalize both sides before matching. */
export function normalizeUnitNumber(unit: string | null | undefined): string {
  const trimmed = (unit ?? "").trim().toLowerCase();
  return trimmed.replace(/^0+(?=.)/, "");
}

export function reviewedKeyFor(billId: string, kind: UtilityExceptionKind): string {
  return `${billId}|${kind}`;
}

/**
 * Portfolio-wide average charge per bill from the months BEFORE `nowIso`'s
 * month — the documented approximation of per-account history (see header).
 * 0 when there is no usable history.
 */
export function typicalBillAmount(monthlyTotals: MlgwMonthlyTotal[], nowIso: string): number {
  const currentMonth = day(nowIso).slice(0, 7);
  let total = 0;
  let bills = 0;
  for (const m of monthlyTotals) {
    if (m.month >= currentMonth) continue;
    total += n(m.total);
    bills += n(m.billCount);
  }
  return bills > 0 ? total / bills : 0;
}

/** Portfolio-typical electric charge: mean of positive electric totals across
 *  unit-account current bills. 0 when the extraction seam gave us nothing. */
export function typicalElectricAmount(
  currentBills: MlgwCurrentBill[],
  accountsById: ReadonlyMap<string, MlgwAccount>,
): number {
  let total = 0;
  let count = 0;
  for (const bill of currentBills) {
    const account = bill.accountId ? accountsById.get(bill.accountId) : undefined;
    if (!account || account.isHouseAccount) continue;
    const electric = n(bill.electricTotal);
    if (electric > 0) {
      total += electric;
      count += 1;
    }
  }
  return count > 0 ? total / count : 0;
}

function accountsById(accounts: MlgwAccount[]): Map<string, MlgwAccount> {
  return new Map(accounts.map((a) => [a.id, a]));
}

// ---- the engine ------------------------------------------------------------

/**
 * Compute every exception across the current bills, sorted most-urgent first
 * (priority asc, amount desc). Reviewed rows are included with
 * `reviewed: true` — callers filter for the open queue.
 */
export function computeUtilityExceptions(
  input: UtilityExceptionInput,
  copy: ExceptionCopy,
): UtilityException[] {
  const byId = accountsById(input.accounts);
  const typicalBill = typicalBillAmount(input.monthlyTotals, input.nowIso);
  const typicalElectric = typicalElectricAmount(input.currentBills, byId);
  const reviewedKeys = new Set(input.reviews.map((r) => `${r.billId}|${r.exceptionKind}`));
  const moveInByUnit = new Map<string, string>();
  for (const unit of input.units) {
    const key = normalizeUnitNumber(unit.unitNumber);
    const moveIn = day(unit.moveInDate);
    if (key && moveIn) moveInByUnit.set(key, moveIn);
  }
  const today = day(input.nowIso);

  const out: UtilityException[] = [];
  const seen = new Set<string>();
  const push = (
    bill: MlgwCurrentBill,
    account: MlgwAccount,
    kind: UtilityExceptionKind,
    amount: number,
    ctx: ExceptionContext,
  ) => {
    const key = reviewedKeyFor(bill.id, kind);
    if (seen.has(key)) return; // one exception per (bill, kind)
    seen.add(key);
    out.push({
      billId: bill.id,
      accountNumber: account.accountNumber,
      unitNumber: account.isHouseAccount ? "" : account.unitNumber,
      isHouseAccount: account.isHouseAccount,
      kind,
      title: copy.title(kind),
      action: copy.action(kind),
      detail: copy.detail(kind, ctx),
      amount: Math.round(amount * 100) / 100,
      priority: EXCEPTION_PRIORITY[kind],
      context: ctx,
      reviewedKey: key,
      reviewed: reviewedKeys.has(key),
    });
  };

  const pastDueFlagged = new Set<string>(); // account ids — flag once, on the newest bill

  for (const bill of input.currentBills) {
    const account = bill.accountId ? byId.get(bill.accountId) : undefined;
    if (!account) continue;
    const isUnit = !account.isHouseAccount;
    const billDate = day(bill.billDate);
    const amountDue = n(bill.amountDue);
    const balanceForward = n(bill.balanceForward);
    const charges = amountDue - balanceForward;

    // spike — unit accounts only (see header for why house meters are exempt).
    if (isUnit && typicalBill > 0 && charges >= SPIKE_MIN_AMOUNT && charges >= SPIKE_RATIO * typicalBill) {
      push(bill, account, "spike", charges, { amount: charges, typical: typicalBill, billDate });
    }

    // high_electrical — absolute threshold, OR well above the portfolio-typical
    // electric charge when the extraction seam produced data.
    const electric = n(bill.electricTotal);
    if (
      isUnit &&
      (electric >= HIGH_ELECTRIC_ABSOLUTE ||
        (typicalElectric > 0 &&
          electric >= HIGH_ELECTRIC_MIN_AMOUNT &&
          electric >= HIGH_ELECTRIC_RATIO * typicalElectric))
    ) {
      push(bill, account, "high_electrical", electric, {
        amount: electric,
        typical: typicalElectric > 0 ? typicalElectric : undefined,
        billDate,
      });
    }

    // billed_after_move_in — the bill predates the current tenant's move-in,
    // so responsibility for it needs a human decision before paying.
    if (isUnit && billDate) {
      const moveIn = moveInByUnit.get(normalizeUnitNumber(account.unitNumber));
      if (moveIn && moveIn > billDate) {
        push(bill, account, "billed_after_move_in", amountDue, {
          amount: amountDue,
          billDate,
          moveInDate: moveIn,
        });
      }
    }

    // balance_forward — money carried in from a prior bill.
    if (balanceForward > 0) {
      push(bill, account, "balance_forward", balanceForward, {
        amount: balanceForward,
        balanceForward,
        billDate,
      });
    }

    // fee_spike — any watched one-off fee present on the bill.
    let feeTotal = 0;
    let topFee: FeeKey | undefined;
    let topFeeAmount = 0;
    for (const [field, feeKey] of FEE_FIELDS) {
      const v = n(bill[field] as number | null | undefined);
      if (v > 0) {
        feeTotal += v;
        if (v > topFeeAmount) {
          topFeeAmount = v;
          topFee = feeKey;
        }
      }
    }
    if (feeTotal > 0) {
      push(bill, account, "fee_spike", feeTotal, { amount: feeTotal, feeKey: topFee, billDate });
    }

    // past_due — account-level (dueDate passed with money still owed),
    // attached to the account's newest current bill so it can be reviewed.
    const accountDue = day(account.dueDate);
    if (
      !pastDueFlagged.has(account.id) &&
      accountDue &&
      today &&
      accountDue < today &&
      n(account.dueNow) > 0
    ) {
      pastDueFlagged.add(account.id);
      push(bill, account, "past_due", n(account.dueNow), {
        amount: n(account.dueNow),
        dueDate: accountDue,
      });
    }
  }

  return out.sort((a, b) => a.priority - b.priority || b.amount - a.amount);
}

// ---- summary builders ------------------------------------------------------

export interface UtilitySummary {
  currentDue: number;
  currentBillCount: number;
  pastDue: number;
  pastDueCount: number;
  houseSpend: number;
  houseAccountCount: number;
  /** Open (unreviewed) spike + high_electrical exceptions. */
  spikeCount: number;
}

/** The Overview metric strip's numbers. Null-tolerant throughout. */
export function buildUtilitySummary(
  accounts: MlgwAccount[],
  currentBills: MlgwCurrentBill[],
  exceptions: UtilityException[],
  nowIso: string,
): UtilitySummary {
  const today = day(nowIso);
  let currentDue = 0;
  let pastDue = 0;
  let pastDueCount = 0;
  let houseSpend = 0;
  let houseAccountCount = 0;
  for (const account of accounts) {
    const due = n(account.dueNow);
    if (due > 0) currentDue += due;
    if (account.isHouseAccount) {
      houseAccountCount += 1;
      if (due > 0) houseSpend += due;
    }
    const dueDate = day(account.dueDate);
    if (due > 0 && dueDate && today && dueDate < today) {
      pastDue += due;
      pastDueCount += 1;
    }
  }
  const spikeCount = exceptions.filter(
    (e) => !e.reviewed && (e.kind === "spike" || e.kind === "high_electrical"),
  ).length;
  return {
    currentDue,
    currentBillCount: currentBills.length,
    pastDue,
    pastDueCount,
    houseSpend,
    houseAccountCount,
    spikeCount,
  };
}

// ---- charge mix ------------------------------------------------------------

export type ChargeSegmentKey = "electric" | "water_sewer" | "gas" | "other" | "non_mlgw";

export interface ChargeSegment {
  key: ChargeSegmentKey;
  amount: number;
  /** Of the categorized total; all segments sum to 1. */
  fraction: number;
}

/**
 * Aggregate bills into the five-way charge mix (electric / water+sewer / gas /
 * other MLGW / non-MLGW). Returns [] when the extraction seam produced no
 * categorized dollars — the caller then renders amountDue-only.
 */
export function chargeMixSegments(bills: readonly MlgwCurrentBill[]): ChargeSegment[] {
  let electric = 0;
  let water = 0;
  let gas = 0;
  let other = 0;
  let nonMlgw = 0;
  for (const b of bills) {
    electric += n(b.electricTotal);
    water += n(b.waterTotal) + n(b.sewerTotal) + n(b.sewerChargeTotal);
    gas += n(b.gasTotal);
    nonMlgw += n(b.nonMlgwTotal);
    other +=
      n(b.otherMlgwTotal) +
      n(b.streetLightFeeTotal) +
      n(b.electricalLateFeeTotal) +
      n(b.securityDepositTotal) +
      n(b.smartMeterConnectChargeTotal) +
      n(b.creditBalanceTransferTotal) +
      n(b.shareThePenniesTotal) +
      n(b.waterCrossConnectionFeeTotal) +
      n(b.leasingOutdoorLightingTotal) +
      n(b.mosquitoRodentControlFeeTotal) +
      n(b.stormWaterFeeTotal) +
      n(b.solidWasteFeeTotal);
  }
  const entries: [ChargeSegmentKey, number][] = [
    ["electric", electric],
    ["water_sewer", water],
    ["gas", gas],
    ["other", other],
    ["non_mlgw", nonMlgw],
  ];
  const total = entries.reduce((sum, [, v]) => sum + Math.max(v, 0), 0);
  if (total <= 0) return [];
  return entries
    .filter(([, v]) => v > 0)
    .map(([key, amount]) => ({
      key,
      amount: Math.round(amount * 100) / 100,
      fraction: amount / total,
    }));
}

// ---- monthly series --------------------------------------------------------

export interface MonthBar {
  month: string;
  total: number;
  billCount: number;
  /** Of the tallest month; 0..1, never NaN. */
  fraction: number;
  /** Tinted in the chart when well above average. */
  hot: boolean;
}

export interface MonthlySpendSeries {
  bars: MonthBar[];
  average: number;
  max: number;
}

/** The 12-month spend chart's geometry. Empty input → empty bars, zero stats. */
export function monthlySpendSeries(monthlyTotals: MlgwMonthlyTotal[]): MonthlySpendSeries {
  if (monthlyTotals.length === 0) return { bars: [], average: 0, max: 0 };
  const totals = monthlyTotals.map((m) => Math.max(n(m.total), 0));
  const max = Math.max(...totals);
  const average = totals.reduce((a, b) => a + b, 0) / totals.length;
  return {
    bars: monthlyTotals.map((m, i) => ({
      month: m.month,
      total: totals[i],
      billCount: n(m.billCount),
      fraction: max > 0 ? totals[i] / max : 0,
      hot: average > 0 && totals[i] >= MONTH_HOT_RATIO * average,
    })),
    average,
    max,
  };
}

export interface MonthOverMonth {
  current: MlgwMonthlyTotal | null;
  previous: MlgwMonthlyTotal | null;
  /** Percent change current vs previous; null when no comparable base. */
  deltaPct: number | null;
}

/** Last two entries of the (ascending) series, with a guarded delta. */
export function monthOverMonth(monthlyTotals: MlgwMonthlyTotal[]): MonthOverMonth {
  const current = monthlyTotals.length > 0 ? monthlyTotals[monthlyTotals.length - 1] : null;
  const previous = monthlyTotals.length > 1 ? monthlyTotals[monthlyTotals.length - 2] : null;
  const deltaPct =
    current && previous && n(previous.total) > 0
      ? ((n(current.total) - n(previous.total)) / n(previous.total)) * 100
      : null;
  return { current, previous, deltaPct };
}

// ---- payables --------------------------------------------------------------

export type PayableStatus = "past_due" | "due_soon" | "ready";
export type PayableOrder = "lowest_first" | "past_due_first";

export interface PayableBill {
  billId: string;
  accountNumber: string;
  unitNumber: string;
  isHouseAccount: boolean;
  serviceAddress: string;
  amount: number;
  dueDate: string | null;
  status: PayableStatus;
}

/** "YYYY-MM-DD" shifted forward `days` (UTC — matches the feed's dates). */
function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The payable list: every current bill with money due, EXCLUDING bills with an
 * open billed-after-move-in flag (those need the responsibility call first —
 * marking the exception reviewed releases the bill back into this list).
 */
export function buildPayables(
  accounts: MlgwAccount[],
  currentBills: MlgwCurrentBill[],
  exceptions: UtilityException[],
  nowIso: string,
): { payables: PayableBill[]; heldForReviewCount: number } {
  const byId = accountsById(accounts);
  const held = new Set(
    exceptions
      .filter((e) => e.kind === "billed_after_move_in" && !e.reviewed)
      .map((e) => e.billId),
  );
  const today = day(nowIso);
  const soonCutoff = today ? shiftDays(today, DUE_SOON_DAYS) : "";

  const payables: PayableBill[] = [];
  let heldForReviewCount = 0;
  for (const bill of currentBills) {
    const account = bill.accountId ? byId.get(bill.accountId) : undefined;
    if (!account) continue;
    const amount = n(bill.amountDue);
    if (amount <= 0) continue;
    if (held.has(bill.id)) {
      heldForReviewCount += 1;
      continue;
    }
    const dueDate = day(bill.dueDate) || day(account.dueDate) || null;
    const status: PayableStatus =
      dueDate && today && dueDate < today
        ? "past_due"
        : dueDate && soonCutoff && dueDate <= soonCutoff
          ? "due_soon"
          : "ready";
    payables.push({
      billId: bill.id,
      accountNumber: account.accountNumber,
      unitNumber: account.isHouseAccount ? "" : account.unitNumber,
      isHouseAccount: account.isHouseAccount,
      serviceAddress: account.serviceAddress,
      amount,
      dueDate,
      status,
    });
  }
  return { payables, heldForReviewCount };
}

const STATUS_RANK: Record<PayableStatus, number> = { past_due: 0, due_soon: 1, ready: 2 };

/** Sort a payable list without mutating it. */
export function sortPayables(payables: readonly PayableBill[], order: PayableOrder): PayableBill[] {
  const copy = [...payables];
  if (order === "lowest_first") return copy.sort((a, b) => a.amount - b.amount);
  return copy.sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") ||
      b.amount - a.amount,
  );
}

// ---- exception grouping ----------------------------------------------------

export interface UnitExceptionGroup {
  /** Account number — stable even for house accounts with no unit. */
  groupKey: string;
  unitNumber: string;
  isHouseAccount: boolean;
  serviceAddress: string;
  /** Sum of OPEN flagged amounts in the group. */
  openTotal: number;
  openCount: number;
  items: UtilityException[];
}

/**
 * Group exceptions per unit/house account for the Exceptions board. Pass
 * `includeReviewed: false` for the working queue; groups sort by open total
 * descending, items by priority.
 */
export function groupExceptionsByUnit(
  exceptions: UtilityException[],
  accounts: MlgwAccount[],
  includeReviewed: boolean,
): UnitExceptionGroup[] {
  const addressByNumber = new Map(accounts.map((a) => [a.accountNumber, a.serviceAddress]));
  const groups = new Map<string, UnitExceptionGroup>();
  for (const e of exceptions) {
    if (!includeReviewed && e.reviewed) continue;
    let group = groups.get(e.accountNumber);
    if (!group) {
      group = {
        groupKey: e.accountNumber,
        unitNumber: e.unitNumber,
        isHouseAccount: e.isHouseAccount,
        serviceAddress: addressByNumber.get(e.accountNumber) ?? "",
        openTotal: 0,
        openCount: 0,
        items: [],
      };
      groups.set(e.accountNumber, group);
    }
    group.items.push(e);
    if (!e.reviewed) {
      group.openTotal += e.amount;
      group.openCount += 1;
    }
  }
  const out = [...groups.values()];
  for (const g of out) g.items.sort((a, b) => a.priority - b.priority || b.amount - a.amount);
  return out.sort((a, b) => b.openTotal - a.openTotal || a.groupKey.localeCompare(b.groupKey));
}

// ---- ledger helpers --------------------------------------------------------

/** Current bills per account id, preserving the feed's newest-first order. */
export function billsByAccount(
  currentBills: MlgwCurrentBill[],
): Map<string, MlgwCurrentBill[]> {
  const map = new Map<string, MlgwCurrentBill[]>();
  for (const bill of currentBills) {
    if (!bill.accountId) continue;
    const list = map.get(bill.accountId);
    if (list) list.push(bill);
    else map.set(bill.accountId, [bill]);
  }
  return map;
}
