import type { Database } from "@/types/database";
import type { UntypedSupabase } from "@/lib/supabase/types";

/**
 * MLGW (utility) feed for the manager app: accounts with current dues, the
 * current bill per account with its charge totals, a 12-month spend series,
 * and the exception-review checklist state. Reads mirror the mlgw_* tables the
 * worker syncs; the only write is the reviewed flag (mlgw_exception_reviews),
 * which is Emberly-owned.
 */

type AccountRow = Database["public"]["Tables"]["mlgw_accounts"]["Row"];
type BillRow = Database["public"]["Tables"]["mlgw_bills"]["Row"];
type ReviewRow = Database["public"]["Tables"]["mlgw_exception_reviews"]["Row"];

// ---- accounts --------------------------------------------------------------

export const MLGW_ACCOUNT_COLUMNS =
  "id, account_number, service_address, unit_number, is_house_account, due_now, due_date";

export type MlgwAccountSelect = Pick<
  AccountRow,
  "id" | "account_number" | "service_address" | "unit_number" | "is_house_account" | "due_now" | "due_date"
>;

export interface MlgwAccountPayload {
  id: string;
  accountNumber: string;
  serviceAddress: string;
  unitNumber: string;
  isHouseAccount: boolean;
  dueNow: number | null;
  dueDate: string | null;
}

export function mlgwAccountPayload(row: MlgwAccountSelect): MlgwAccountPayload {
  return {
    id: row.id,
    accountNumber: row.account_number,
    serviceAddress: row.service_address,
    unitNumber: row.unit_number,
    isHouseAccount: row.is_house_account,
    dueNow: row.due_now,
    dueDate: row.due_date,
  };
}

// ---- current bills ---------------------------------------------------------

export const MLGW_CURRENT_BILL_COLUMNS =
  "id, mlgw_account_id, bill_date, due_date, amount_due, balance_forward, gas_total, " +
  "electric_total, water_total, sewer_total, other_mlgw_total, non_mlgw_total, " +
  "street_light_fee_total, electrical_late_fee_total, security_deposit_total, " +
  "smart_meter_connect_charge_total, credit_balance_transfer_total, share_the_pennies_total, " +
  "water_cross_connection_fee_total, leasing_outdoor_lighting_total, " +
  "mosquito_rodent_control_fee_total, sewer_charge_total, storm_water_fee_total, " +
  "solid_waste_fee_total";

export type MlgwCurrentBillSelect = Pick<
  BillRow,
  | "id"
  | "mlgw_account_id"
  | "bill_date"
  | "due_date"
  | "amount_due"
  | "balance_forward"
  | "gas_total"
  | "electric_total"
  | "water_total"
  | "sewer_total"
  | "other_mlgw_total"
  | "non_mlgw_total"
  | "street_light_fee_total"
  | "electrical_late_fee_total"
  | "security_deposit_total"
  | "smart_meter_connect_charge_total"
  | "credit_balance_transfer_total"
  | "share_the_pennies_total"
  | "water_cross_connection_fee_total"
  | "leasing_outdoor_lighting_total"
  | "mosquito_rodent_control_fee_total"
  | "sewer_charge_total"
  | "storm_water_fee_total"
  | "solid_waste_fee_total"
>;

export interface MlgwCurrentBillPayload {
  id: string;
  accountId: string | null;
  billDate: string | null;
  dueDate: string | null;
  amountDue: number | null;
  balanceForward: number | null;
  gasTotal: number | null;
  electricTotal: number | null;
  waterTotal: number | null;
  sewerTotal: number | null;
  otherMlgwTotal: number | null;
  nonMlgwTotal: number | null;
  streetLightFeeTotal: number | null;
  electricalLateFeeTotal: number | null;
  securityDepositTotal: number | null;
  smartMeterConnectChargeTotal: number | null;
  creditBalanceTransferTotal: number | null;
  shareThePenniesTotal: number | null;
  waterCrossConnectionFeeTotal: number | null;
  leasingOutdoorLightingTotal: number | null;
  mosquitoRodentControlFeeTotal: number | null;
  sewerChargeTotal: number | null;
  stormWaterFeeTotal: number | null;
  solidWasteFeeTotal: number | null;
}

export function mlgwCurrentBillPayload(row: MlgwCurrentBillSelect): MlgwCurrentBillPayload {
  return {
    id: row.id,
    accountId: row.mlgw_account_id,
    billDate: row.bill_date,
    dueDate: row.due_date,
    amountDue: row.amount_due,
    balanceForward: row.balance_forward,
    gasTotal: row.gas_total,
    electricTotal: row.electric_total,
    waterTotal: row.water_total,
    sewerTotal: row.sewer_total,
    otherMlgwTotal: row.other_mlgw_total,
    nonMlgwTotal: row.non_mlgw_total,
    streetLightFeeTotal: row.street_light_fee_total,
    electricalLateFeeTotal: row.electrical_late_fee_total,
    securityDepositTotal: row.security_deposit_total,
    smartMeterConnectChargeTotal: row.smart_meter_connect_charge_total,
    creditBalanceTransferTotal: row.credit_balance_transfer_total,
    shareThePenniesTotal: row.share_the_pennies_total,
    waterCrossConnectionFeeTotal: row.water_cross_connection_fee_total,
    leasingOutdoorLightingTotal: row.leasing_outdoor_lighting_total,
    mosquitoRodentControlFeeTotal: row.mosquito_rodent_control_fee_total,
    sewerChargeTotal: row.sewer_charge_total,
    stormWaterFeeTotal: row.storm_water_fee_total,
    solidWasteFeeTotal: row.solid_waste_fee_total,
  };
}

// ---- monthly totals --------------------------------------------------------

export interface MlgwMonthlyTotal {
  /** "YYYY-MM". */
  month: string;
  total: number;
  billCount: number;
}

/** "YYYY-MM" for `nowMs` shifted back `monthsBack` calendar months (UTC). */
export function monthKey(nowMs: number, monthsBack = 0): string {
  const now = new Date(nowMs);
  const shifted = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
  return shifted.toISOString().slice(0, 7);
}

/** First day of the month 11 months back — the 12-month window's floor. */
export function monthlyWindowStart(nowMs: number): string {
  return `${monthKey(nowMs, 11)}-01`;
}

/**
 * Pure aggregation of bills into the last-12-months series (current month
 * included), ascending. Months with no bills are omitted; bills without a
 * bill_date or outside the window are skipped.
 */
export function monthlyBillTotals(
  rows: readonly Pick<BillRow, "bill_date" | "amount_due">[],
  nowMs: number,
): MlgwMonthlyTotal[] {
  const floor = monthKey(nowMs, 11);
  const ceiling = monthKey(nowMs, 0);
  const byMonth = new Map<string, { total: number; billCount: number }>();
  for (const row of rows) {
    if (!row.bill_date) continue;
    const month = row.bill_date.slice(0, 7);
    if (month < floor || month > ceiling) continue;
    const bucket = byMonth.get(month) ?? { total: 0, billCount: 0 };
    bucket.total += row.amount_due ?? 0;
    bucket.billCount += 1;
    byMonth.set(month, bucket);
  }
  return [...byMonth.keys()].sort().map((month) => {
    const bucket = byMonth.get(month) ?? { total: 0, billCount: 0 };
    return { month, total: Math.round(bucket.total * 100) / 100, billCount: bucket.billCount };
  });
}

// ---- exception reviews -----------------------------------------------------

export const MLGW_REVIEW_COLUMNS = "id, bill_id, account_number, exception_kind, reviewed_at";

export type MlgwReviewSelect = Pick<
  ReviewRow,
  "id" | "bill_id" | "account_number" | "exception_kind" | "reviewed_at"
>;

export interface MlgwReviewPayload {
  id: string;
  billId: string;
  accountNumber: string;
  exceptionKind: string;
  reviewedAt: string | null;
}

export function mlgwReviewPayload(row: MlgwReviewSelect): MlgwReviewPayload {
  return {
    id: row.id,
    billId: row.bill_id,
    accountNumber: row.account_number,
    exceptionKind: row.exception_kind,
    reviewedAt: row.reviewed_at,
  };
}

/** The natural key the sync also uses: propertyId|billId|exceptionKind. */
export function mlgwReviewId(propertyId: string, billId: string, exceptionKind: string): string {
  return `${propertyId}|${billId}|${exceptionKind}`;
}

// ---- reads -----------------------------------------------------------------

export interface ManagerMlgwPayload {
  accounts: MlgwAccountPayload[];
  currentBills: MlgwCurrentBillPayload[];
  monthlyTotals: MlgwMonthlyTotal[];
  reviews: MlgwReviewPayload[];
}

/** The whole MLGW surface in one chunky payload. */
export async function getManagerMlgw(
  client: UntypedSupabase,
  nowMs: number = Date.now(),
): Promise<ManagerMlgwPayload> {
  const accountsRes = await client
    .from("mlgw_accounts")
    .select(MLGW_ACCOUNT_COLUMNS)
    .order("account_number", { ascending: true });
  if (accountsRes.error) throw new Error(accountsRes.error.message);

  const billsRes = await client
    .from("mlgw_bills")
    .select(MLGW_CURRENT_BILL_COLUMNS)
    .eq("is_current", true)
    .order("bill_date", { ascending: false });
  if (billsRes.error) throw new Error(billsRes.error.message);

  const monthlyRes = await client
    .from("mlgw_bills")
    .select("bill_date, amount_due")
    .gte("bill_date", monthlyWindowStart(nowMs));
  if (monthlyRes.error) throw new Error(monthlyRes.error.message);

  const reviewsRes = await client
    .from("mlgw_exception_reviews")
    .select(MLGW_REVIEW_COLUMNS)
    .order("reviewed_at", { ascending: false });
  if (reviewsRes.error) throw new Error(reviewsRes.error.message);

  return {
    accounts: ((accountsRes.data ?? []) as MlgwAccountSelect[]).map(mlgwAccountPayload),
    currentBills: ((billsRes.data ?? []) as MlgwCurrentBillSelect[]).map(mlgwCurrentBillPayload),
    monthlyTotals: monthlyBillTotals(
      (monthlyRes.data ?? []) as Pick<BillRow, "bill_date" | "amount_due">[],
      nowMs,
    ),
    reviews: ((reviewsRes.data ?? []) as MlgwReviewSelect[]).map(mlgwReviewPayload),
  };
}

// ---- reviewed write --------------------------------------------------------

export interface MlgwReviewInput {
  billId: string;
  accountNumber?: string;
  exceptionKind: string;
  reviewed: boolean;
}

export type MlgwReviewResult =
  | { ok: true; reviewed: boolean }
  | { ok: false; status: number; error: string };

/**
 * reviewed=true upserts the checklist row under the sync's natural key
 * (property id resolved from the bill row — 404 when the bill is unknown);
 * reviewed=false clears it by (bill_id, exception_kind), which needs no
 * property lookup and still works after the bill itself is re-synced away.
 */
export async function setMlgwReviewed(
  client: UntypedSupabase,
  input: MlgwReviewInput,
): Promise<MlgwReviewResult> {
  if (!input.reviewed) {
    const { error } = await client
      .from("mlgw_exception_reviews")
      .delete()
      .eq("bill_id", input.billId)
      .eq("exception_kind", input.exceptionKind);
    if (error) throw new Error(error.message);
    return { ok: true, reviewed: false };
  }

  const billRes = await client
    .from("mlgw_bills")
    .select("id, resman_property_id")
    .eq("id", input.billId)
    .maybeSingle();
  if (billRes.error) throw new Error(billRes.error.message);
  const bill = billRes.data as Pick<BillRow, "id" | "resman_property_id"> | null;
  if (!bill) return { ok: false, status: 404, error: "Bill not found" };

  const { error } = await client
    .from("mlgw_exception_reviews")
    .upsert(
      {
        id: mlgwReviewId(bill.resman_property_id, input.billId, input.exceptionKind),
        resman_property_id: bill.resman_property_id,
        bill_id: input.billId,
        account_number: input.accountNumber ?? "",
        exception_kind: input.exceptionKind,
        reviewed_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
  if (error) throw new Error(error.message);
  return { ok: true, reviewed: true };
}
