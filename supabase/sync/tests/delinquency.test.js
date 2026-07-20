const assert = require("node:assert/strict");
const test = require("node:test");

const { CsvHeaderLookup } = require("../src/resman/csv.ts");
const {
  extractAccountingPeriods,
  resolveAccountingPeriodId,
  accountingPeriodLabel,
  formatMMDDYYYY,
  monthStart,
  monthEnd,
  buildDelinquencyForm,
  mapDelinquencyRow,
  DEFAULT_DELINQUENCY_LEASE_STATUSES,
  DEFAULT_DELINQUENCY_OTHER_ACCOUNTS,
} = require("../src/resman/reports/delinquency.ts");

const HTML = `
  <select id="period">
    <option value="2026-07">July 2026</option>
    <option value="2026-06">June 2026</option>
  </select>`;

test("extractAccountingPeriods + resolveAccountingPeriodId (case-insensitive)", () => {
  const periods = extractAccountingPeriods(HTML);
  assert.deepEqual(periods, [
    { id: "2026-07", label: "July 2026" },
    { id: "2026-06", label: "June 2026" },
  ]);
  assert.equal(resolveAccountingPeriodId(HTML, "july 2026"), "2026-07");
  assert.throws(() => resolveAccountingPeriodId(HTML, "March 2026"), /Could not find accounting period/);
});

test("date helpers", () => {
  assert.equal(accountingPeriodLabel(new Date(2026, 6, 15)), "July 2026");
  assert.equal(formatMMDDYYYY(new Date(2026, 6, 4)), "07/04/2026");
  assert.equal(formatMMDDYYYY(monthStart(new Date(2026, 6, 15))), "07/01/2026");
  assert.equal(formatMMDDYYYY(monthEnd(new Date(2026, 6, 15))), "07/31/2026");
  assert.equal(formatMMDDYYYY(monthEnd(new Date(2026, 1, 10))), "02/28/2026"); // non-leap Feb
});

test("buildDelinquencyForm carries period, repeated statuses/accounts, and balances", () => {
  const fields = buildDelinquencyForm(
    { csrfToken: "tok", dxCss: "css" },
    {
      propertyOrGroupId: "P1",
      accountingPeriodId: "2026-07",
      accountingPeriodLabel: "July 2026",
      startDate: "07/01/2026",
      endDate: "07/31/2026",
    },
  );
  const byName = (n) => fields.filter(([k]) => k === n).map(([, v]) => v);
  assert.deepEqual(byName("PeriodOrDateRangeParameter.DateType"), ["Period"]);
  assert.deepEqual(byName("PeriodOrDateRangeParameter.AccountingPeriodID"), ["2026-07"]);
  assert.equal(byName("LeaseStatusesParameter.SelectedItems").length, DEFAULT_DELINQUENCY_LEASE_STATUSES.length);
  assert.equal(byName("OtherAccountsParameter.SelectedItems").length, DEFAULT_DELINQUENCY_OTHER_ACCOUNTS.length);
  assert.deepEqual(byName("MinimumBalanceParameter.Value"), ["0.00"]);
  assert.deepEqual(byName("MaximumBalanceParameter.Value"), ["0.00"]);
  assert.equal(fields[fields.length - 1][0], "Export");
});

const HEADERS = [
  "Unit", "TotalBalance", "Balance0to30", "Balance31to60", "PeriodBalance",
  "PreviousBalance", "TimesLate", "DelinquencyReason",
];
const lookup = new CsvHeaderLookup(HEADERS);
const row = (v) => HEADERS.map((h) => v[h] ?? "");

test("mapDelinquencyRow parses balances + reference, skips blank/no-unit", () => {
  const m = mapDelinquencyRow(
    lookup,
    row({
      Unit: "101", TotalBalance: "$1,250.50", Balance0to30: "250.50", Balance31to60: "1000",
      PeriodBalance: "1250.50", PreviousBalance: "0", TimesLate: "3", DelinquencyReason: "NSF",
    }),
  );
  assert.equal(m.unitReference, "101");
  assert.equal(m.values.balance, 1250.5);
  assert.equal(m.values.current_month_balance, 250.5);
  assert.equal(m.values.last_month_balance, 1000);
  assert.equal(m.values.times_late, 3);
  assert.equal(m.values.delinquency_reason, "NSF");

  assert.equal(mapDelinquencyRow(lookup, row({})), null); // all blank
  assert.equal(mapDelinquencyRow(lookup, row({ TotalBalance: "5" })), null); // no Unit reference
});
