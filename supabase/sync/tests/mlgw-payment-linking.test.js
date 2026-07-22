const assert = require("node:assert/strict");
const test = require("node:test");

const { accountIdByNormalizedNumber, linkPaymentRowsToAccounts } = require("../src/mlgw/jobs.ts");

test("payments link to accounts across number formatting (dashed vs digits)", () => {
  const idByNumber = accountIdByNormalizedNumber([
    { id: "acct-1", account_number: "00136-4306-1416-817" },
    { id: "acct-2", account_number: "00136-4306-1417-820" },
  ]);
  const rows = [
    { mlgw_account_id: null, account_number: "0013643061416817" },
    { mlgw_account_id: null, account_number: "0013643061417820" },
    { mlgw_account_id: null, account_number: "9999999999999999" },
  ];
  assert.equal(linkPaymentRowsToAccounts(rows, idByNumber), 2);
  assert.equal(rows[0].mlgw_account_id, "acct-1");
  assert.equal(rows[1].mlgw_account_id, "acct-2");
  assert.equal(rows[2].mlgw_account_id, null); // unknown number stays unlinked
});

test("ambiguous account numbers are dropped, blank ones ignored", () => {
  const idByNumber = accountIdByNormalizedNumber([
    { id: "acct-a", account_number: "111-222" },
    { id: "acct-b", account_number: "111222" }, // same digits, different account
    { id: "acct-c", account_number: null },
    { id: "acct-d", account_number: "333-444" },
  ]);
  assert.equal(idByNumber.has("111222"), false);
  assert.equal(idByNumber.get("333444"), "acct-d");
  const rows = [{ mlgw_account_id: null, account_number: "111222" }];
  assert.equal(linkPaymentRowsToAccounts(rows, idByNumber), 0);
  assert.equal(rows[0].mlgw_account_id, null);
});
