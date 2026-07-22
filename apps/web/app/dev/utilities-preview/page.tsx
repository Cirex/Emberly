import { notFound } from "next/navigation";
import {
  accountSummaries,
  billDetailStats,
  buildLedgerTree,
  currentMonthMix,
  monthOverMonth,
  monthlySpendSeries,
  type UtilityAccount,
  type UtilityBill,
  type UtilityPayment,
  type UtilityUnitFacts,
} from "@/lib/admin-utilities";
import { PreviewHarness } from "./harness";

/**
 * DEV-ONLY visual harness for the utilities components — fixture data, no
 * auth, 404s in production. Exists so layout work can be screenshotted
 * without an admin session; delete freely if it gets in the way.
 */

function bill(over: Partial<UtilityBill>): UtilityBill {
  return {
    id: "b", mlgw_account_id: "acct-1", document_id: "0", is_current: false,
    bill_date: "2025-10-01", due_date: "2025-10-22", amount_due: 54.75, balance_forward: 0,
    bill_for: "Xela Capital LLC", file_path: "", gas_total: 6.92, electric_total: 21,
    water_total: 22.83, sewer_total: 4, other_mlgw_total: 5, non_mlgw_total: null,
    sewer_charge_total: null, street_light_fee_total: 3.1, electrical_late_fee_total: null,
    security_deposit_total: null, smart_meter_connect_charge_total: null,
    credit_balance_transfer_total: null, share_the_pennies_total: 0.5,
    water_cross_connection_fee_total: null, leasing_outdoor_lighting_total: null,
    mosquito_rodent_control_fee_total: null, storm_water_fee_total: 1.4, solid_waste_fee_total: null,
    ...over,
  } as UtilityBill;
}

export default function UtilitiesPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();

  const accounts: UtilityAccount[] = [
    {
      id: "acct-1", account_number: "00136-4306-1416-817", service_address: "3713 Kings Gate Dr Apt 3",
      unit_number: "3713 KG-3", resman_unit_id: "u-1", is_house_account: false,
      due_now: 87, due_date: "2026-08-06",
    },
    {
      id: "acct-h", account_number: "00136-4306-1132-277", service_address: "House Meter — 3619 Kingsgate",
      unit_number: "", resman_unit_id: "", is_house_account: true, due_now: 412.4, due_date: "2026-08-06",
    },
  ];
  const bills: UtilityBill[] = [
    bill({ id: "b-oct1", document_id: "742507240", bill_date: "2025-10-01", amount_due: 54.75 }),
    bill({ id: "b-oct29", document_id: "754556658", bill_date: "2025-10-29", amount_due: 87, balance_forward: 54.75, electric_total: 55 }),
    bill({ id: "b-jul", document_id: "857716956", bill_date: "2026-07-16", due_date: "2026-08-06", amount_due: 60, is_current: true, balance_forward: 8.4, electric_total: 24, file_path: "x.pdf" }),
    bill({ id: "b-h", document_id: "857716999", mlgw_account_id: "acct-h", bill_date: "2026-07-16", amount_due: 412.4, is_current: true, electric_total: 300 }),
    bill({ id: "b-h-jun", document_id: "841356529", mlgw_account_id: "acct-h", bill_date: "2026-06-16", amount_due: 371.9, electric_total: 260 }),
    bill({ id: "b-jun", document_id: "841356651", bill_date: "2026-06-16", amount_due: 51.65 }),
  ];
  const payments: UtilityPayment[] = [
    { id: "p-1", mlgw_account_id: "acct-1", reference_number: "534649452052", status: "Processed",
      amount: 87, paid_date: "2025-11-29", payment_method: "Credit Card", authorization_number: "258499" },
  ];
  const unit: UtilityUnitFacts = {
    resman_unit_id: "u-1", unit_number: "3713 KG-3", occupancy_status: "Occupied",
    tenant_names: ["Jamal Whitfield"], move_in_date: "2026-06-15", move_out_date: null,
    lease_start_date: "2026-06-15", lease_end_date: "2027-06-15",
  };

  const now = Date.parse("2026-07-21T12:00:00Z");
  const summaries = accountSummaries(accounts, bills, now);
  const acctBills = bills.filter((b) => b.mlgw_account_id === "acct-1");
  const current = acctBills.find((b) => b.is_current)!;
  const detail = {
    bills: acctBills,
    payments,
    tree: buildLedgerTree(acctBills, payments),
    stats: billDetailStats(acctBills, current, unit),
    unit,
  };

  return (
    <div style={{ minHeight: "100vh", background: "#F7F8FC", padding: 24 }}>
      <PreviewHarness
        summary={summaries[0]}
        detail={detail}
        series={monthlySpendSeries(bills, now)}
        goal={500}
        mix={currentMonthMix(accounts, bills)}
        mom={monthOverMonth(accounts, bills, new Set(["u-vac"]))}
      />
    </div>
  );
}
