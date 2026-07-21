import { createUntypedAdminClient } from "@/lib/supabase/admin";
import {
  accountSummaries,
  buildLedgerTree,
  billDetailStats,
  currentMonthMix,
  detectExceptions,
  monthOverMonth,
  monthlySpendSeries,
  type UtilityAccount,
  type UtilityBill,
  type UtilityPayment,
  type UtilityUnitFacts,
} from "@/lib/admin-utilities";
import { UtilitiesClient, type UtilitiesPayload } from "./utilities-client";

export const dynamic = "force-dynamic";

/**
 * /admin/utilities — the XMS utilities dashboard on the portal (approved
 * artifact, 2026-07-21). Server-assembled from the full mlgw_* mirror plus
 * the ResMan unit mirror for the occupancy overlay; the client is a pure
 * renderer with tab state and the review toggle.
 */

const ACCOUNT_COLUMNS =
  "id, account_number, service_address, unit_number, resman_unit_id, is_house_account, due_now, due_date";
const BILL_COLUMNS =
  "id, mlgw_account_id, document_id, is_current, bill_date, due_date, amount_due, balance_forward, " +
  "bill_for, file_path, gas_total, electric_total, water_total, sewer_total, other_mlgw_total, " +
  "non_mlgw_total, sewer_charge_total, street_light_fee_total, electrical_late_fee_total, " +
  "security_deposit_total, smart_meter_connect_charge_total, credit_balance_transfer_total, " +
  "share_the_pennies_total, water_cross_connection_fee_total, leasing_outdoor_lighting_total, " +
  "mosquito_rodent_control_fee_total, storm_water_fee_total, solid_waste_fee_total";
const PAYMENT_COLUMNS =
  "id, mlgw_account_id, reference_number, status, amount, paid_date, payment_method, authorization_number";
// resman_units names its unit column `number`; alias to the facts shape.
const UNIT_COLUMNS =
  "resman_unit_id, unit_number:number, occupancy_status, tenant_names, move_in_date, move_out_date, lease_start_date, lease_end_date";

/** The portal's spend goal; unset draws no goal line, matching XMS. */
function spendGoal(): number | null {
  const raw = Number.parseFloat(process.env.UTILITIES_MONTHLY_SPEND_GOAL ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** PostgREST caps unbounded selects at 1000 rows; page the full mirror out. */
const PAGE = 1000;
async function fetchAll<T>(
  query: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await query(from, from + PAGE - 1);
    if (res.error) throw new Error(res.error.message);
    const page = (res.data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

export default async function UtilitiesPage() {
  const client = createUntypedAdminClient();
  const nowMs = Date.now();

  let payload: UtilitiesPayload | null = null;
  let initialError = "";
  try {
    const [accounts, bills, payments, reviews] = await Promise.all([
      fetchAll<UtilityAccount>((from, to) =>
        client.from("mlgw_accounts").select(ACCOUNT_COLUMNS).order("account_number").order("id").range(from, to),
      ),
      fetchAll<UtilityBill>((from, to) =>
        client.from("mlgw_bills").select(BILL_COLUMNS).order("bill_date", { ascending: false }).order("id").range(from, to),
      ),
      fetchAll<UtilityPayment>((from, to) =>
        client.from("mlgw_payments").select(PAYMENT_COLUMNS).order("paid_date", { ascending: false }).order("id").range(from, to),
      ),
      fetchAll<{ bill_id: string; exception_kind: string }>((from, to) =>
        client.from("mlgw_exception_reviews").select("bill_id, exception_kind").order("bill_id").range(from, to),
      ),
    ]);
    const reviewedKeys = new Set(reviews.map((r) => `${r.bill_id}|${r.exception_kind}`));

    // Occupancy overlay. Whole-table read: 600+ linked accounts would build a
    // ~24KB `.in()` URL, and the mirror is under a thousand rows anyway.
    const referencedUnitIds = new Set(accounts.map((a) => a.resman_unit_id).filter(Boolean));
    const facts = new Map<string, UtilityUnitFacts>();
    if (referencedUnitIds.size > 0) {
      const units = await fetchAll<UtilityUnitFacts>((from, to) =>
        client.from("resman_units").select(UNIT_COLUMNS).order("resman_unit_id").range(from, to),
      );
      for (const u of units) {
        if (referencedUnitIds.has(u.resman_unit_id)) facts.set(u.resman_unit_id, u);
      }
    }
    const vacantUnitIds = new Set(
      [...facts.values()].filter((u) => (u.occupancy_status ?? "").toLowerCase().includes("vacant")).map((u) => u.resman_unit_id),
    );

    const summaries = accountSummaries(accounts, bills, nowMs);
    const billsByAccount = new Map<string, UtilityBill[]>();
    for (const b of bills) {
      const id = b.mlgw_account_id ?? "";
      const list = billsByAccount.get(id);
      if (list) list.push(b);
      else billsByAccount.set(id, [b]);
    }
    const paymentsByAccount = new Map<string, UtilityPayment[]>();
    for (const p of payments) {
      const id = p.mlgw_account_id ?? "";
      const list = paymentsByAccount.get(id);
      if (list) list.push(p);
      else paymentsByAccount.set(id, [p]);
    }

    payload = {
      generatedAt: nowMs,
      spendGoal: spendGoal(),
      series: monthlySpendSeries(bills, nowMs),
      mix: currentMonthMix(accounts, bills),
      mom: monthOverMonth(accounts, bills, vacantUnitIds),
      summaries,
      exceptions: detectExceptions(accounts, bills, facts, reviewedKeys),
      // Detail bundles precomputed per account — the dataset is one property
      // (~tens of accounts), so shipping it beats a second fetch round-trip.
      details: Object.fromEntries(
        accounts.map((account) => {
          const accountBills = billsByAccount.get(account.id) ?? [];
          const accountPayments = paymentsByAccount.get(account.id) ?? [];
          const current = accountBills.find((b) => b.is_current) ?? accountBills[0] ?? null;
          const unit = account.resman_unit_id ? (facts.get(account.resman_unit_id) ?? null) : null;
          return [
            account.id,
            {
              bills: accountBills,
              payments: accountPayments,
              tree: buildLedgerTree(accountBills, accountPayments),
              stats: current ? billDetailStats(accountBills, current, unit) : null,
              unit,
            },
          ];
        }),
      ),
    };
  } catch (error) {
    console.error("[admin/utilities page] Failed to load:", error);
    initialError = "Could not load utility data. Check the MLGW sync and try again.";
  }

  return <UtilitiesClient payload={payload} initialError={initialError} />;
}
