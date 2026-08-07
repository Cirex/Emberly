const assert = require("node:assert/strict");
const test = require("node:test");

const { stampSynced } = require("../src/mlgw/jobs.ts");
const { toAccountRow, toBillRow } = require("../src/mlgw/parse/bill-import.ts");
const { toPaymentRow } = require("../src/mlgw/parse/payment-import.ts");

const PROPERTY = { id: "prop-1", name: "Test Property" };

const billDTO = (over = {}) => ({
  accountNumber: "00136-4306-1416-817",
  documentId: "doc-1",
  isCurrent: true,
  billDate: "07/15/2026",
  amountDue: "123.45",
  balanceForward: "0.00",
  averageTemperature: "82",
  dueDate: "08/01/2026",
  billFor: "Apt 101",
  servicesAt: "101 Main St",
  filePath: "",
  charges: [],
  ...over,
});

test("stampSynced writes synced_at on every row without disturbing the rest", () => {
  // Regression guard. `synced_at timestamptz default now()` fires on INSERT
  // only — an ON CONFLICT DO UPDATE never re-applies a column default — so with
  // no explicit stamp mlgw_accounts/mlgw_bills froze at their 2026-07-22 seed
  // while every row was in fact re-upserted on every pass. Anything reading
  // max(synced_at) then reported MLGW as ~8 days stale on current data.
  const rows = [{ id: "a", amount_due: 1 }, { id: "b", amount_due: 2 }];
  const stamped = stampSynced(rows, "2026-07-31T00:00:00.000Z");

  assert.equal(stamped, rows, "stamps in place and returns the same array");
  for (const row of stamped) {
    assert.equal(row.synced_at, "2026-07-31T00:00:00.000Z");
  }
  assert.equal(stamped[0].amount_due, 1, "other columns are untouched");
  assert.equal(stamped[1].id, "b");
});

test("stampSynced is a no-op on an empty batch", () => {
  assert.deepEqual(stampSynced([], "2026-07-31T00:00:00.000Z"), []);
});

test("the account and bill mappers leave synced_at to the job-layer stamp", () => {
  // The stamp is ONE timestamp per pass, applied in the job (jobs.ts) rather
  // than per row in these pure port mappers — same shape as the ResMan
  // unit-detail fix. If a stamp ever moves in here, it must be a real pass
  // timestamp threaded through, not `new Date()` per row.
  const bill = toBillRow(billDTO(), PROPERTY);
  const account = toAccountRow(billDTO(), PROPERTY);
  assert.equal(bill.synced_at, undefined);
  assert.equal(account.synced_at, undefined);

  // …and the job's stamp is what puts it there.
  assert.equal(stampSynced([bill], "2026-07-31T00:00:00.000Z")[0].synced_at, "2026-07-31T00:00:00.000Z");
});

test("payment rows carry NO synced_at — mlgw_payments has no such column", () => {
  // mlgw_payments (schema.sql) is the one mirror table in this job without a
  // `synced_at` column. Stamping a payment row would make PostgREST reject the
  // whole upsert, so the job deliberately stamps accounts and bills only.
  const payment = toPaymentRow(
    {
      accountNumber: "00136-4306-1416-817",
      referenceNumber: "REF-9001",
      status: "Posted",
      amount: "50.00",
      paidDate: "07/20/2026",
      paymentMethod: "Card",
      authorizationNumber: "auth-1",
      detailText: "",
      accountSelection: "",
      detailFetchedAt: null,
    },
    PROPERTY.id,
  );
  assert.ok(payment !== null);
  assert.equal("synced_at" in payment, false);
});
