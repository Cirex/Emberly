import { describe, expect, test } from "bun:test";
import type { MlgwAccount, MlgwCurrentBill, MlgwMonthlyTotal, MlgwReview } from "@/lib/api/mlgw";
import {
  HIGH_ELECTRIC_ABSOLUTE,
  billsByAccount,
  buildPayables,
  buildUtilitySummary,
  chargeMixSegments,
  computeUtilityExceptions,
  groupExceptionsByUnit,
  monthOverMonth,
  monthlySpendSeries,
  normalizeUnitNumber,
  reviewedKeyFor,
  sortPayables,
  typicalBillAmount,
  type ExceptionCopy,
  type UtilityExceptionInput,
} from "@/lib/derived/utility-exceptions";
import {
  accountLast4,
  formatDeltaPct,
  formatMoney,
  formatMoneyWhole,
  formatMonthLabel,
  formatShortDate,
} from "@/lib/derived/utility-format";

const NOW = "2026-07-21";

const copy: ExceptionCopy = {
  title: (kind) => `title:${kind}`,
  action: (kind) => `action:${kind}`,
  detail: (kind, ctx) => `detail:${kind}:${ctx.amount}`,
};

function account(over: Partial<MlgwAccount> = {}): MlgwAccount {
  return {
    id: "acct-1",
    accountNumber: "100008841",
    serviceAddress: "4280 Ridgestone Dr",
    unitNumber: "0644",
    isHouseAccount: false,
    dueNow: 0,
    dueDate: null,
    ...over,
  };
}

function bill(over: Partial<MlgwCurrentBill> = {}): MlgwCurrentBill {
  return {
    id: "bill-1",
    accountId: "acct-1",
    billDate: "2026-07-18",
    dueDate: "2026-07-28",
    amountDue: 0,
    balanceForward: 0,
    gasTotal: null,
    electricTotal: null,
    waterTotal: null,
    sewerTotal: null,
    otherMlgwTotal: null,
    nonMlgwTotal: null,
    streetLightFeeTotal: null,
    electricalLateFeeTotal: null,
    securityDepositTotal: null,
    smartMeterConnectChargeTotal: null,
    creditBalanceTransferTotal: null,
    shareThePenniesTotal: null,
    waterCrossConnectionFeeTotal: null,
    leasingOutdoorLightingTotal: null,
    mosquitoRodentControlFeeTotal: null,
    sewerChargeTotal: null,
    stormWaterFeeTotal: null,
    solidWasteFeeTotal: null,
    ...over,
  };
}

function review(over: Partial<MlgwReview> = {}): MlgwReview {
  return {
    id: "r1",
    billId: "bill-1",
    accountNumber: "100008841",
    exceptionKind: "spike",
    reviewedAt: "2026-07-20T10:00:00Z",
    ...over,
  };
}

/** History averaging $100/bill across two prior months. */
const HISTORY: MlgwMonthlyTotal[] = [
  { month: "2026-05", total: 1000, billCount: 10 },
  { month: "2026-06", total: 1000, billCount: 10 },
  { month: "2026-07", total: 5000, billCount: 10 }, // current month — must be excluded
];

function input(over: Partial<UtilityExceptionInput> = {}): UtilityExceptionInput {
  return {
    accounts: [account()],
    currentBills: [bill()],
    monthlyTotals: HISTORY,
    reviews: [],
    units: [],
    nowIso: NOW,
    ...over,
  };
}

const kindsOf = (i: UtilityExceptionInput) =>
  computeUtilityExceptions(i, copy).map((e) => e.kind);

describe("typicalBillAmount (history approximation)", () => {
  test("averages prior months only, excluding the current month", () => {
    // (1000 + 1000) / (10 + 10) = 100 — the 2026-07 outlier must not count.
    expect(typicalBillAmount(HISTORY, NOW)).toBe(100);
  });

  test("no history → 0 (spike rule disarms rather than dividing by zero)", () => {
    expect(typicalBillAmount([], NOW)).toBe(0);
    expect(typicalBillAmount([{ month: "2026-07", total: 500, billCount: 5 }], NOW)).toBe(0);
  });
});

describe("spike", () => {
  test("flags charges >= 1.75× the typical bill (net of balance forward)", () => {
    // charges = 200 - 20 = 180 >= 175
    const out = computeUtilityExceptions(
      input({ currentBills: [bill({ amountDue: 200, balanceForward: 20 })] }),
      copy,
    );
    const spike = out.find((e) => e.kind === "spike");
    expect(spike).toBeDefined();
    expect(spike?.amount).toBe(180);
    expect(spike?.title).toBe("title:spike");
    expect(spike?.reviewedKey).toBe(reviewedKeyFor("bill-1", "spike"));
  });

  test("does not flag below the ratio", () => {
    expect(
      kindsOf(input({ currentBills: [bill({ amountDue: 174, balanceForward: 0 })] })),
    ).not.toContain("spike");
  });

  test("never flags without history", () => {
    expect(
      kindsOf(input({ monthlyTotals: [], currentBills: [bill({ amountDue: 900 })] })),
    ).not.toContain("spike");
  });

  test("house accounts are exempt (portfolio average would always misfire)", () => {
    const out = kindsOf(
      input({
        accounts: [account({ isHouseAccount: true })],
        currentBills: [bill({ amountDue: 2000 })],
      }),
    );
    expect(out).not.toContain("spike");
    expect(out).not.toContain("high_electrical");
  });
});

describe("high_electrical", () => {
  test("absolute threshold flags regardless of history", () => {
    const out = computeUtilityExceptions(
      input({ currentBills: [bill({ electricTotal: HIGH_ELECTRIC_ABSOLUTE })] }),
      copy,
    );
    expect(out.map((e) => e.kind)).toContain("high_electrical");
  });

  test("relative threshold uses the portfolio-typical electric charge", () => {
    // Mean electric = (30+30+30+120)/4 = 52.5 → 120 >= 1.75×52.5 and >= $60.
    const accounts = [1, 2, 3, 4].map((i) => account({ id: `a${i}`, unitNumber: `06${i}` }));
    const bills = [30, 30, 30, 120].map((electric, i) =>
      bill({ id: `b${i + 1}`, accountId: `a${i + 1}`, electricTotal: electric, amountDue: electric }),
    );
    const out = computeUtilityExceptions(input({ accounts, currentBills: bills }), copy);
    const hits = out.filter((e) => e.kind === "high_electrical");
    expect(hits).toHaveLength(1);
    expect(hits[0].billId).toBe("b4");
    expect(hits[0].amount).toBe(120);
  });

  test("null electric totals never flag or produce NaN", () => {
    const out = computeUtilityExceptions(input(), copy);
    expect(out.every((e) => Number.isFinite(e.amount))).toBe(true);
    expect(out.map((e) => e.kind)).not.toContain("high_electrical");
  });
});

describe("billed_after_move_in", () => {
  test("flags when the matched unit's move-in postdates the bill", () => {
    const out = computeUtilityExceptions(
      input({
        currentBills: [bill({ amountDue: 96 })],
        units: [{ unitNumber: "644", moveInDate: "2026-07-21" }], // note: no leading zero
      }),
      copy,
    );
    const hit = out.find((e) => e.kind === "billed_after_move_in");
    expect(hit).toBeDefined();
    expect(hit?.amount).toBe(96);
    expect(hit?.context.moveInDate).toBe("2026-07-21");
  });

  test("no flag when move-in is on or before the bill date", () => {
    expect(
      kindsOf(input({ units: [{ unitNumber: "0644", moveInDate: "2026-07-18" }] })),
    ).not.toContain("billed_after_move_in");
    expect(
      kindsOf(input({ units: [{ unitNumber: "0644", moveInDate: "2026-06-01" }] })),
    ).not.toContain("billed_after_move_in");
  });

  test("unit-number matching normalizes leading zeros and case", () => {
    expect(normalizeUnitNumber("0644")).toBe("644");
    expect(normalizeUnitNumber(" 644 ")).toBe("644");
    expect(normalizeUnitNumber("0")).toBe("0");
    expect(normalizeUnitNumber("A12")).toBe("a12");
  });
});

describe("balance_forward, fee_spike, past_due", () => {
  test("balance forward > 0 flags with the carried amount", () => {
    const out = computeUtilityExceptions(
      input({ currentBills: [bill({ amountDue: 180, balanceForward: 142 })] }),
      copy,
    );
    const hit = out.find((e) => e.kind === "balance_forward");
    expect(hit?.amount).toBe(142);
  });

  test("fee_spike sums the watched fees and names the largest", () => {
    const out = computeUtilityExceptions(
      input({
        currentBills: [
          bill({ electricalLateFeeTotal: 38, smartMeterConnectChargeTotal: 12 }),
        ],
      }),
      copy,
    );
    const hit = out.find((e) => e.kind === "fee_spike");
    expect(hit?.amount).toBe(50);
    expect(hit?.context.feeKey).toBe("electrical_late");
  });

  test("past_due flags once per account, on its bill, from account dues", () => {
    const out = computeUtilityExceptions(
      input({
        accounts: [account({ dueNow: 180.22, dueDate: "2026-07-10" })],
        currentBills: [bill({ id: "b1" }), bill({ id: "b2" })],
      }),
      copy,
    );
    const hits = out.filter((e) => e.kind === "past_due");
    expect(hits).toHaveLength(1);
    expect(hits[0].amount).toBe(180.22);
  });

  test("future due date or zero balance never flags past_due", () => {
    expect(
      kindsOf(input({ accounts: [account({ dueNow: 50, dueDate: "2026-08-01" })] })),
    ).not.toContain("past_due");
    expect(
      kindsOf(input({ accounts: [account({ dueNow: 0, dueDate: "2026-07-01" })] })),
    ).not.toContain("past_due");
  });
});

describe("reviewed matching", () => {
  test("marks the (billId, kind) pair reviewed; other kinds stay open", () => {
    const out = computeUtilityExceptions(
      input({
        currentBills: [bill({ amountDue: 300, balanceForward: 50 })],
        reviews: [review({ exceptionKind: "spike" })],
      }),
      copy,
    );
    expect(out.find((e) => e.kind === "spike")?.reviewed).toBe(true);
    expect(out.find((e) => e.kind === "balance_forward")?.reviewed).toBe(false);
  });

  test("sorted by priority then amount", () => {
    const out = computeUtilityExceptions(
      input({
        accounts: [account({ dueNow: 10, dueDate: "2026-07-01" })],
        currentBills: [bill({ amountDue: 300, balanceForward: 50 })],
      }),
      copy,
    );
    const priorities = out.map((e) => e.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });
});

describe("summary and charge mix (null-tolerant)", () => {
  test("summary totals dues, past dues, house spend, and open spikes", () => {
    const accounts = [
      account({ id: "a1", unitNumber: "0644", dueNow: 200, dueDate: "2026-07-28" }),
      account({ id: "a2", unitNumber: "0538", dueNow: 100, dueDate: "2026-07-01" }),
      account({ id: "a3", isHouseAccount: true, unitNumber: "", dueNow: 300, dueDate: "2026-07-30" }),
    ];
    const bills = [
      bill({ id: "b1", accountId: "a1", amountDue: 200 }), // spike (typical 100)
      bill({ id: "b2", accountId: "a2", amountDue: 100 }),
      bill({ id: "b3", accountId: "a3", amountDue: 300 }),
    ];
    const exceptions = computeUtilityExceptions(
      input({ accounts, currentBills: bills }),
      copy,
    );
    const s = buildUtilitySummary(accounts, bills, exceptions, NOW);
    expect(s.currentDue).toBe(600);
    expect(s.currentBillCount).toBe(3);
    expect(s.pastDue).toBe(100);
    expect(s.pastDueCount).toBe(1);
    expect(s.houseSpend).toBe(300);
    expect(s.houseAccountCount).toBe(1);
    expect(s.spikeCount).toBe(1);
    expect(Object.values(s).every((v) => Number.isFinite(v))).toBe(true);
  });

  test("charge mix fractions sum to 1 and drop zero segments", () => {
    const segments = chargeMixSegments([
      bill({ electricTotal: 131, waterTotal: 34, sewerTotal: 6, gasTotal: 21, nonMlgwTotal: 11 }),
    ]);
    expect(segments.map((s) => s.key)).toEqual(["electric", "water_sewer", "gas", "non_mlgw"]);
    expect(segments.reduce((sum, s) => sum + s.fraction, 0)).toBeCloseTo(1);
    expect(segments.find((s) => s.key === "water_sewer")?.amount).toBe(40);
  });

  test("all-null charge fields degrade to an empty mix, never NaN", () => {
    expect(chargeMixSegments([bill({ amountDue: 250 })])).toEqual([]);
    expect(chargeMixSegments([])).toEqual([]);
  });
});

describe("monthly series", () => {
  test("fractions scale to the max and hot months tint", () => {
    const { bars, average, max } = monthlySpendSeries([
      { month: "2026-05", total: 100, billCount: 5 },
      { month: "2026-06", total: 100, billCount: 5 },
      { month: "2026-07", total: 400, billCount: 5 },
    ]);
    expect(max).toBe(400);
    expect(average).toBe(200);
    expect(bars[2].fraction).toBe(1);
    expect(bars[2].hot).toBe(true); // 400 >= 1.35 × 200
    expect(bars[0].hot).toBe(false);
    expect(bars.every((b) => Number.isFinite(b.fraction))).toBe(true);
  });

  test("empty and all-zero series never divide by zero", () => {
    expect(monthlySpendSeries([])).toEqual({ bars: [], average: 0, max: 0 });
    const zero = monthlySpendSeries([{ month: "2026-07", total: 0, billCount: 0 }]);
    expect(zero.bars[0].fraction).toBe(0);
    expect(zero.bars[0].hot).toBe(false);
  });

  test("month over month delta guards a zero base", () => {
    expect(
      monthOverMonth([
        { month: "2026-06", total: 9105, billCount: 40 },
        { month: "2026-07", total: 9812, billCount: 41 },
      ]).deltaPct,
    ).toBeCloseTo(7.77, 1);
    expect(
      monthOverMonth([
        { month: "2026-06", total: 0, billCount: 0 },
        { month: "2026-07", total: 100, billCount: 1 },
      ]).deltaPct,
    ).toBeNull();
    expect(monthOverMonth([]).current).toBeNull();
  });
});

describe("payables", () => {
  const accounts = [
    account({ id: "a1", unitNumber: "0644", dueDate: "2026-07-28" }),
    account({ id: "a2", unitNumber: "0538", accountNumber: "200005507", dueDate: "2026-07-01" }),
  ];

  test("excludes bills with an OPEN billed-after-move-in flag and counts them", () => {
    const bills = [
      bill({ id: "b1", accountId: "a1", amountDue: 96 }),
      bill({ id: "b2", accountId: "a2", amountDue: 180, dueDate: "2026-07-01" }),
    ];
    const exceptions = computeUtilityExceptions(
      input({
        accounts,
        currentBills: bills,
        units: [{ unitNumber: "0644", moveInDate: "2026-07-21" }],
      }),
      copy,
    );
    const { payables, heldForReviewCount } = buildPayables(accounts, bills, exceptions, NOW);
    expect(payables.map((p) => p.billId)).toEqual(["b2"]);
    expect(heldForReviewCount).toBe(1);
    expect(payables[0].status).toBe("past_due");
  });

  test("a reviewed move-in flag releases the bill back into the list", () => {
    const bills = [bill({ id: "b1", accountId: "a1", amountDue: 96 })];
    const exceptions = computeUtilityExceptions(
      input({
        accounts,
        currentBills: bills,
        units: [{ unitNumber: "0644", moveInDate: "2026-07-21" }],
        reviews: [review({ billId: "b1", exceptionKind: "billed_after_move_in" })],
      }),
      copy,
    );
    const { payables, heldForReviewCount } = buildPayables(accounts, bills, exceptions, NOW);
    expect(payables.map((p) => p.billId)).toEqual(["b1"]);
    expect(heldForReviewCount).toBe(0);
  });

  test("statuses and both sort orders", () => {
    const bills = [
      bill({ id: "b1", accountId: "a1", amountDue: 300, dueDate: "2026-07-24" }), // due soon
      bill({ id: "b2", accountId: "a2", amountDue: 50, dueDate: "2026-07-01" }), // past due
      bill({ id: "b3", accountId: "a1", amountDue: 120, dueDate: "2026-08-15" }), // ready
    ];
    const { payables } = buildPayables(accounts, bills, [], NOW);
    expect(payables.find((p) => p.billId === "b1")?.status).toBe("due_soon");
    expect(payables.find((p) => p.billId === "b3")?.status).toBe("ready");
    expect(sortPayables(payables, "lowest_first").map((p) => p.amount)).toEqual([50, 120, 300]);
    expect(sortPayables(payables, "past_due_first").map((p) => p.billId)).toEqual([
      "b2",
      "b1",
      "b3",
    ]);
  });

  test("zero/negative dues never enter the list", () => {
    const { payables } = buildPayables(
      accounts,
      [bill({ id: "b1", accountId: "a1", amountDue: 0 }), bill({ id: "b2", accountId: "a1", amountDue: null })],
      [],
      NOW,
    );
    expect(payables).toEqual([]);
  });
});

describe("grouping and ledger helpers", () => {
  test("groups per account with open totals, sorted by exposure", () => {
    const accounts = [
      account({ id: "a1", accountNumber: "111", unitNumber: "0644" }),
      account({ id: "a2", accountNumber: "222", unitNumber: "0538" }),
    ];
    const bills = [
      bill({ id: "b1", accountId: "a1", amountDue: 300, balanceForward: 50 }), // spike + bal fwd
      bill({ id: "b2", accountId: "a2", amountDue: 100, balanceForward: 20 }), // bal fwd only
    ];
    const exceptions = computeUtilityExceptions(input({ accounts, currentBills: bills }), copy);
    const groups = groupExceptionsByUnit(exceptions, accounts, false);
    expect(groups[0].unitNumber).toBe("0644");
    expect(groups[0].openTotal).toBe(300); // 250 spike + 50 bal fwd
    expect(groups[1].openTotal).toBe(20);
  });

  test("includeReviewed folds cleared rows in without counting them open", () => {
    const accounts = [account({ id: "a1", accountNumber: "111" })];
    const bills = [bill({ id: "b1", accountId: "a1", balanceForward: 42 })];
    const exceptions = computeUtilityExceptions(
      input({
        accounts,
        currentBills: bills,
        reviews: [review({ billId: "b1", exceptionKind: "balance_forward" })],
      }),
      copy,
    );
    expect(groupExceptionsByUnit(exceptions, accounts, false)).toEqual([]);
    const all = groupExceptionsByUnit(exceptions, accounts, true);
    expect(all).toHaveLength(1);
    expect(all[0].openCount).toBe(0);
    expect(all[0].items[0].reviewed).toBe(true);
  });

  test("billsByAccount preserves feed order per account", () => {
    const map = billsByAccount([
      bill({ id: "b1", accountId: "a1" }),
      bill({ id: "b2", accountId: "a2" }),
      bill({ id: "b3", accountId: "a1" }),
      bill({ id: "b4", accountId: null }),
    ]);
    expect(map.get("a1")?.map((b) => b.id)).toEqual(["b1", "b3"]);
    expect(map.get("a2")?.map((b) => b.id)).toEqual(["b2"]);
    expect(map.size).toBe(2);
  });
});

describe("formatting", () => {
  test("money", () => {
    expect(formatMoney(212.4)).toBe("$212.40");
    expect(formatMoney(1234.5)).toBe("$1,234.50");
    expect(formatMoney(-34.1)).toBe("-$34.10");
    expect(formatMoney(null)).toBe("$0.00");
    expect(formatMoney(Number.NaN)).toBe("$0.00");
    expect(formatMoneyWhole(9812.4)).toBe("$9,812");
    expect(formatMoneyWhole(123_456)).toBe("$123k");
    expect(formatMoneyWhole(undefined)).toBe("$0");
  });

  test("deltas", () => {
    expect(formatDeltaPct(7.77)).toBe("+7.8%");
    expect(formatDeltaPct(-1.4)).toBe("−1.4%");
    expect(formatDeltaPct(0)).toBe("0%");
    expect(formatDeltaPct(null)).toBe("—");
    expect(formatDeltaPct(Number.NaN)).toBe("—");
  });

  test("dates stay in UTC and reject junk", () => {
    expect(formatShortDate("2026-07-18", "en")).toBe("Jul 18");
    expect(formatShortDate("2026-07-18T05:00:00Z", "en")).toBe("Jul 18");
    expect(formatShortDate("nope", "en")).toBe("");
    expect(formatShortDate(null, "en")).toBe("");
    expect(formatMonthLabel("2026-07", "en")).toBe("Jul");
    expect(formatMonthLabel("", "en")).toBe("");
  });

  test("account tails", () => {
    expect(accountLast4("100008841")).toBe("8841");
    expect(accountLast4("41-2")).toBe("412");
    expect(accountLast4("")).toBe("····");
  });
});
