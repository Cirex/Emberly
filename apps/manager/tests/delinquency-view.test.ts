import { describe, expect, test } from "bun:test";
import type {
  DelinquencyAction,
  DelinquentUnit,
  LeaseLedgerSummary,
  LedgerEntry,
  ManagerLease,
} from "@/lib/api/delinquency";
import {
  agentDrillIn,
  agentLeaseInputs,
  agingDistribution,
  assembleTenantPnl,
  buildAgentBoard,
  buildBalancesBoard,
  buildTimeline,
  firstLateDelayBucket,
  isSilent,
  lastPaymentMap,
  legalMap,
  promiseStatusByLease,
  suggestNextAction,
  tenantBands,
  type NextActionContext,
} from "@/lib/derived/delinquency-view";

const NOW = Date.parse("2026-07-15T12:00:00Z");

// ---- factories -------------------------------------------------------------

let unitSeq = 0;
function unit(over: Partial<DelinquentUnit> = {}): DelinquentUnit {
  unitSeq += 1;
  return {
    unitId: `u${unitSeq}`,
    unitNumber: `07${unitSeq}`,
    tenantNames: ["Marcus Sanders"],
    balance: 500,
    currentMonthBalance: 500,
    lastMonthBalance: 0,
    periodBalance: 0,
    previousBalance: 0,
    timesLate: 0,
    delinquencyReason: "",
    leasingAgent: "DJ",
    currentLeaseId: `L-u${unitSeq}`,
    marketRent: 1200,
    ...over,
  };
}

let actionSeq = 0;
function action(over: Partial<DelinquencyAction> & { resmanLeaseId: string }): DelinquencyAction {
  actionSeq += 1;
  return {
    id: `a${actionSeq}`,
    resmanUnitId: "",
    unitNumber: "",
    kind: "note",
    note: "",
    amount: null,
    promiseDueDate: null,
    createdBy: "BB",
    createdAt: "2026-07-01T10:00:00Z",
    ...over,
  };
}

function lease(over: Partial<ManagerLease> & { id: string }): ManagerLease {
  return {
    unitId: null,
    unitNumber: "0731",
    status: "Current",
    approvalStatus: "Approved",
    applicationDate: "2024-02-15",
    signedDate: null,
    startDate: "2024-03-01",
    endDate: null,
    moveInDate: "2024-03-01",
    moveOutDate: null,
    leasingAgent: "DJ",
    marketRent: 1200,
    residentRent: 1180,
    balance: 0,
    isCurrentLease: true,
    isMostRecentLease: true,
    ...over,
  };
}

function summary(over: Partial<LeaseLedgerSummary> & { leaseId: string }): LeaseLedgerSummary {
  return {
    billed: 10_000,
    collected: 10_000,
    lastPaymentDate: null,
    firstLateMonth: null,
    concessions: 0,
    writeoffs: 0,
    legalFiledDate: null,
    legalServedDate: null,
    legalFees: 0,
    ...over,
  };
}

let entrySeq = 0;
function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  entrySeq += 1;
  return {
    id: `e${entrySeq}`,
    date: "2026-07-01",
    transactionType: "Charge",
    category: "Rent",
    description: "July rent",
    charges: 1180,
    credits: 0,
    balance: null,
    ...over,
  };
}

// ---- aging distribution ----------------------------------------------------

describe("agingDistribution", () => {
  test("sums each aging column into its bucket with percents of total", () => {
    const dist = agingDistribution([
      unit({ currentMonthBalance: 300, lastMonthBalance: 100, periodBalance: 0, previousBalance: 0 }),
      unit({ currentMonthBalance: 100, lastMonthBalance: 0, periodBalance: 200, previousBalance: 300 }),
    ]);
    expect(dist.total).toBe(1000);
    expect(dist.segments.map((s) => s.amount)).toEqual([400, 100, 200, 300]);
    expect(dist.segments[0].percent).toBeCloseTo(0.4);
    expect(dist.segments[3].percent).toBeCloseTo(0.3);
  });

  test("clamps credit (negative) columns to zero and handles the empty board", () => {
    const dist = agingDistribution([
      unit({ currentMonthBalance: -50, lastMonthBalance: 100, periodBalance: null, previousBalance: null }),
    ]);
    expect(dist.segments[0].amount).toBe(0);
    expect(dist.total).toBe(100);

    const empty = agingDistribution([]);
    expect(empty.total).toBe(0);
    expect(empty.segments.every((s) => s.percent === 0)).toBe(true);
  });
});

// ---- promise status --------------------------------------------------------

describe("promiseStatusByLease", () => {
  const promise = (due: string, leaseId = "L1") =>
    action({
      resmanLeaseId: leaseId,
      kind: "promise_recorded",
      promiseDueDate: due,
      amount: 590,
      createdAt: "2026-07-01T10:00:00Z",
    });

  test("future due date is open", () => {
    const map = promiseStatusByLease([promise("2026-07-22")], new Map(), NOW);
    expect(map.get("L1")?.state).toBe("open");
    expect(map.get("L1")?.dueDate).toBe("2026-07-22");
  });

  test("past due with nothing since is broken", () => {
    const map = promiseStatusByLease([promise("2026-07-10")], new Map(), NOW);
    expect(map.get("L1")?.state).toBe("broken");
  });

  test("promise_kept after the promise marks it kept", () => {
    const kept = action({ resmanLeaseId: "L1", kind: "promise_kept", createdAt: "2026-07-12T09:00:00Z" });
    const map = promiseStatusByLease([promise("2026-07-10"), kept], new Map(), NOW);
    expect(map.get("L1")?.state).toBe("kept");
  });

  test("a ledger payment after the promise counts as kept once due passes", () => {
    const map = promiseStatusByLease([promise("2026-07-10")], new Map([["L1", "2026-07-09"]]), NOW);
    expect(map.get("L1")?.state).toBe("kept");
  });

  test("payments from before the promise do not rescue a broken one", () => {
    const map = promiseStatusByLease([promise("2026-07-10")], new Map([["L1", "2026-06-20"]]), NOW);
    expect(map.get("L1")?.state).toBe("broken");
  });

  test("uses the latest promise per lease; undated promises are ignored", () => {
    const older = promise("2026-07-05");
    const newer = action({
      resmanLeaseId: "L1",
      kind: "payment_plan",
      promiseDueDate: "2026-08-01",
      createdAt: "2026-07-08T10:00:00Z",
    });
    const undated = action({ resmanLeaseId: "L2", kind: "promise_recorded", promiseDueDate: null });
    const map = promiseStatusByLease([older, newer, undated], new Map(), NOW);
    expect(map.get("L1")?.state).toBe("open");
    expect(map.get("L1")?.dueDate).toBe("2026-08-01");
    expect(map.has("L2")).toBe(false);
  });
});

// ---- next-action decision table --------------------------------------------

describe("suggestNextAction (decision table)", () => {
  const base: NextActionContext = {
    bucket: "0-30",
    evicted: false,
    hasFedFiled: false,
    hasEvictionCompleted: false,
    hasNoticeServed: false,
    hasWriteoff: false,
    hasAnyAction: false,
    promiseState: null,
    balance: 500,
  };

  test("1 · evicted owing with no writeoff → writeOff", () => {
    expect(suggestNextAction({ ...base, evicted: true })).toBe("writeOff");
    expect(suggestNextAction({ ...base, evicted: true, hasWriteoff: true })).not.toBe("writeOff");
    expect(suggestNextAction({ ...base, evicted: true, balance: 0 })).not.toBe("writeOff");
  });

  test("2 · FED filed and not completed → awaitCourt", () => {
    expect(suggestNextAction({ ...base, hasFedFiled: true, hasAnyAction: true })).toBe("awaitCourt");
  });

  test("3 · broken promise → escalate", () => {
    expect(suggestNextAction({ ...base, bucket: "31-60", promiseState: "broken", hasAnyAction: true })).toBe(
      "escalate",
    );
  });

  test("4/5 · 90+ escalates to FED after a notice, else serve notice", () => {
    expect(suggestNextAction({ ...base, bucket: "90+", hasNoticeServed: true, hasAnyAction: true })).toBe("fileFed");
    expect(suggestNextAction({ ...base, bucket: "90+" })).toBe("serveNotice");
  });

  test("6 · open promise → onTrack", () => {
    expect(suggestNextAction({ ...base, bucket: "31-60", promiseState: "open", hasAnyAction: true })).toBe("onTrack");
  });

  test("7/8 · mid-aged debt: serve notice when silent, call after contact", () => {
    expect(suggestNextAction({ ...base, bucket: "31-60" })).toBe("serveNotice");
    expect(suggestNextAction({ ...base, bucket: "61-90", hasAnyAction: true })).toBe("call");
  });

  test("9/10 · current cycle watches; reason-only rows get review", () => {
    expect(suggestNextAction(base)).toBe("watch");
    expect(suggestNextAction({ ...base, bucket: null, balance: 0 })).toBe("review");
  });
});

// ---- balances board --------------------------------------------------------

describe("buildBalancesBoard", () => {
  test("bands: promise beats needs-action; aged debt needs action; 0-30 is current cycle", () => {
    const aged = unit({
      unitId: "aged",
      currentLeaseId: "L-aged",
      previousBalance: 900,
      currentMonthBalance: 0,
      balance: 900,
    });
    const promised = unit({ unitId: "prom", currentLeaseId: "L-prom", lastMonthBalance: 590, balance: 590 });
    const fresh = unit({ unitId: "fresh", currentLeaseId: "L-fresh", currentMonthBalance: 212, balance: 212 });
    const actions = [
      action({
        resmanLeaseId: "L-prom",
        kind: "promise_recorded",
        promiseDueDate: "2026-07-22",
        createdAt: "2026-07-10T10:00:00Z",
      }),
    ];
    const board = buildBalancesBoard([aged, promised, fresh], actions, new Map(), NOW);
    expect(board.bands.needsAction.map((r) => r.unit.unitId)).toEqual(["aged"]);
    expect(board.bands.promise.map((r) => r.unit.unitId)).toEqual(["prom"]);
    expect(board.bands.currentCycle.map((r) => r.unit.unitId)).toEqual(["fresh"]);
    expect(board.totalOwed).toBe(900 + 590 + 212);
    expect(board.ninetyPlusCount).toBe(1);
    expect(board.promiseCount).toBe(1);
    expect(board.noActionCount).toBe(2);
  });

  test("rows sort by priority: older debt outranks bigger young debt; broken promise boosts", () => {
    const big30 = unit({ unitId: "big", currentLeaseId: "L-big", currentMonthBalance: 4800, balance: 4800 });
    const old90 = unit({
      unitId: "old",
      currentLeaseId: "L-old",
      previousBalance: 400,
      currentMonthBalance: 0,
      balance: 400,
    });
    const board = buildBalancesBoard([big30, old90], [], new Map(), NOW);
    expect(board.rows[0].unit.unitId).toBe("old");

    const broken = buildBalancesBoard(
      [big30, unit({ unitId: "brk", currentLeaseId: "L-brk", currentMonthBalance: 100, balance: 100 })],
      [
        action({
          resmanLeaseId: "L-brk",
          kind: "promise_recorded",
          promiseDueDate: "2026-07-01",
          createdAt: "2026-06-20T10:00:00Z",
        }),
      ],
      new Map(),
      NOW,
    );
    const brkRow = broken.rows.find((r) => r.unit.unitId === "brk")!;
    expect(brkRow.promise?.state).toBe("broken");
    expect(brkRow.priority).toBeGreaterThan(1000 + 100 / 10); // bucket + balance + broken bonus
  });

  test("eviction via reason text lands in needs action with the eviction counted", () => {
    const ev = unit({
      unitId: "ev",
      currentLeaseId: "L-ev",
      delinquencyReason: "Eviction filed 6/2",
      currentMonthBalance: 250,
      balance: 250,
    });
    const board = buildBalancesBoard([ev], [], new Map(), NOW);
    expect(board.evictionCount).toBe(1);
    expect(board.bands.needsAction[0].unit.unitId).toBe("ev");
    expect(board.bands.needsAction[0].suggestion).toBe("writeOff");
  });

  test("a ledger filing needs action and awaits court even on a young balance", () => {
    // 1840 BA-2's shape: current, paying, only a 0-30 balance — but a $235
    // court fee was charged in March. Reading the note alone (which says
    // nothing) this row would sit in the current cycle and be told to "watch".
    const filed = unit({
      unitId: "filed",
      currentLeaseId: "L-filed",
      currentMonthBalance: 300,
      balance: 300,
    });
    const quiet = unit({ unitId: "quiet", currentLeaseId: "L-quiet", currentMonthBalance: 300, balance: 300 });
    const legal = legalMap([
      summary({ leaseId: "L-filed", legalFiledDate: "2026-03-04", legalServedDate: "2026-03-25", legalFees: 280 }),
      summary({ leaseId: "L-quiet" }),
    ]);

    const board = buildBalancesBoard([filed, quiet], [], new Map(), NOW, new Map(), legal);
    const filedRow = board.rows.find((r) => r.unit.unitId === "filed")!;
    const quietRow = board.rows.find((r) => r.unit.unitId === "quiet")!;

    expect(filedRow.band).toBe("needsAction");
    expect(filedRow.suggestion).toBe("awaitCourt");
    expect(filedRow.legal).toEqual({ filedDate: "2026-03-04", servedDate: "2026-03-25", fees: 280 });
    // The unfiled twin is identical in every other way and stays a watch item.
    expect(quietRow.band).toBe("currentCycle");
    expect(quietRow.suggestion).toBe("watch");
    expect(quietRow.legal).toBeNull();

    expect(board.fedFiledCount).toBe(1);
    expect(board.legalSpend).toBe(280);
    // The eviction chip counts note-text evictions AND ledger filings, so its
    // count and its filter agree.
    expect(filedRow.inEviction).toBe(true);
    expect(quietRow.inEviction).toBe(false);
    expect(board.evictionCount).toBe(1);
  });

  test("daysSincePayment measures the ledger, not when staff last typed a note", () => {
    const u = unit({ unitId: "u1", currentLeaseId: "L-1", currentMonthBalance: 500, balance: 500 });
    const board = buildBalancesBoard([u], [], new Map([["L-1", "2026-05-11"]]), NOW);
    // NOW is 2026-07-15 in this suite.
    expect(board.rows[0].daysSincePayment).toBe(65);

    const never = buildBalancesBoard([u], [], new Map(), NOW);
    expect(never.rows[0].daysSincePayment).toBeNull();
  });

  test("silent counts 60+ days without a payment, and never-paid", () => {
    const quiet = unit({ unitId: "quiet", currentLeaseId: "L-q", currentMonthBalance: 400, balance: 400 });
    const paying = unit({ unitId: "pay", currentLeaseId: "L-p", currentMonthBalance: 400, balance: 400 });
    const never = unit({ unitId: "nev", currentLeaseId: "L-n", currentMonthBalance: 400, balance: 400 });
    const board = buildBalancesBoard(
      [quiet, paying, never],
      [],
      // NOW is 2026-07-15: 65 days silent, 14 days ago, and never.
      new Map([
        ["L-q", "2026-05-11"],
        ["L-p", "2026-07-01"],
      ]),
      NOW,
    );
    expect(board.silentCount).toBe(2);
    expect(board.rows.filter(isSilent).map((r) => r.unit.unitId).sort()).toEqual(["nev", "quiet"]);
  });
});

// ---- tenant P&L ------------------------------------------------------------

describe("assembleTenantPnl", () => {
  test("net = collected − concessions − badDebt(writeoffs + open) − legal; verdict follows", () => {
    const theLease = lease({ id: "L1", unitId: "u-1", balance: 2180, moveInDate: "2024-03-01" });
    const theUnit = unit({ unitId: "u-1", currentLeaseId: "L1", timesLate: 5 });
    const theSummary = summary({
      leaseId: "L1",
      billed: 20_060,
      collected: 16_846,
      concessions: 1034,
      writeoffs: 0,
    });
    const legalAction = action({ resmanLeaseId: "L1", kind: "fed_filed", amount: 385 });
    const [pnl] = assembleTenantPnl({
      leases: [theLease],
      units: [theUnit],
      summaries: [theSummary],
      actions: [legalAction],
      nowMs: NOW,
    });
    expect(pnl.openBalance).toBe(2180);
    expect(pnl.badDebt).toBe(2180);
    expect(pnl.legal).toBe(385);
    expect(pnl.net).toBe(16_846 - 1034 - 2180 - 385);
    expect(pnl.verdict).toBe("profitable"); // 13,247 over 28 months clears $150/mo
    expect(pnl.utilityExposure).toBe(0);
    expect(pnl.maintenanceEstimate).toBe(0);
    expect(pnl.monthsOccupied).toBe(28); // Mar 2024 → Jul 2026
    expect(pnl.timesLate).toBe(5);
  });

  test("losses get a loss verdict; leases without a summary are skipped", () => {
    const bad = lease({ id: "L2", unitId: null, balance: 6940, isCurrentLease: false, status: "Evicted" });
    const noLedger = lease({ id: "L3" });
    const pnls = assembleTenantPnl({
      leases: [bad, noLedger],
      units: [],
      summaries: [summary({ leaseId: "L2", billed: 14_300, collected: 6600, writeoffs: 3000 })],
      actions: [],
      nowMs: NOW,
    });
    expect(pnls).toHaveLength(1);
    expect(pnls[0].evicted).toBe(true);
    expect(pnls[0].badDebt).toBe(3000 + 6940);
    expect(pnls[0].net).toBe(6600 - (3000 + 6940));
    expect(pnls[0].verdict).toBe("loss");
  });

  test("bands rank losses deepest-first with a top-performer contrast band", () => {
    const mk = (id: string, net: number, months = 24): Parameters<typeof tenantBands>[0][number] =>
      ({
        ...assembleTenantPnl({
          leases: [lease({ id, moveInDate: "2024-07-01" })],
          units: [],
          summaries: [summary({ leaseId: id, billed: 30_000, collected: 30_000 })],
          actions: [],
          nowMs: NOW,
        })[0],
        net,
        verdict: net < 0 ? "loss" : net / months < 150 ? "marginal" : "profitable",
      });
    const bands = tenantBands([mk("a", -1410), mk("b", 41_730), mk("c", -6940), mk("d", 27_905), mk("e", 900)]);
    expect(bands.losses.map((p) => p.leaseId)).toEqual(["c", "a"]);
    expect(bands.topPerformers.map((p) => p.leaseId)).toEqual(["b", "d"]);
    expect(bands.rest.map((p) => p.leaseId)).toEqual(["e"]);
  });
});

// ---- agent stats mapping ---------------------------------------------------

describe("agentLeaseInputs / agentDrillIn", () => {
  test("evicted derives from unit reason, lease status, or an eviction action", () => {
    const leases = [
      lease({ id: "L1", unitId: "u-1" }), // unit reason
      lease({ id: "L2", status: "Evicted 3/26", isCurrentLease: false }), // status text
      lease({ id: "L3" }), // action
      lease({ id: "L4" }), // clean
    ];
    const units = [unit({ unitId: "u-1", delinquencyReason: "EVICTION in progress", currentLeaseId: "L1" })];
    const actions = [action({ resmanLeaseId: "L3", kind: "eviction_completed" })];
    const inputs = agentLeaseInputs(leases, units, [summary({ leaseId: "L1", firstLateMonth: "2024-05" })], actions);
    expect(inputs.map((i) => i.evicted)).toEqual([true, true, true, false]);
    expect(inputs[0].firstLateMonth).toBe("2024-05");
  });

  /**
   * The property's eviction figure has to count every eviction, not just the
   * ones a scorecard can claim.
   *
   * buildAgentStats skips a lease with a blank agent, and ResMan only started
   * recording an agent recently — 87% of leases starting in 2026 carry one
   * against 12% of 2025's. Summing the scorecards therefore reported 55 of the
   * property's 153 evictions and a 7.8% rate where the true figure is 12.6%,
   * and the gap was invisible because the unattributed book is rendered
   * nowhere.
   */
  test("property eviction totals count unattributed leases too", () => {
    const leases = [
      lease({ id: "L1", leasingAgent: "DJ", status: "Evicted", isCurrentLease: false }),
      lease({ id: "L2", leasingAgent: "", status: "Evicted", isCurrentLease: false }),
      lease({ id: "L3", leasingAgent: "", status: "Under Eviction", isCurrentLease: false }),
      lease({ id: "L4", leasingAgent: "DJ" }),
    ];
    const board = buildAgentBoard(leases, [], [], [], { windowMonths: 12, nowMs: NOW });

    expect(board.totalEvictions).toBe(3);
    expect(board.unattributedLeases).toBe(2);
    expect(board.unattributedEvictions).toBe(2);
    // Only DJ gets a scorecard, and it shows the one eviction DJ owns — the
    // per-agent numbers are unchanged, it is the PROPERTY total that was wrong.
    expect(board.stats.map((s) => s.agent)).toEqual(["DJ"]);
    expect(board.stats[0].evictions).toBe(1);
  });

  test("the eviction rate is over tenancies — an application was never one", () => {
    // A denied or cancelled application never became a tenancy and could never
    // have ended in an eviction, so counting it only dilutes the rate.
    const leases = [
      lease({ id: "L1", status: "Evicted", isCurrentLease: false }),
      lease({ id: "L2" }),
      lease({ id: "L3", status: "Denied", moveInDate: null, isCurrentLease: false }),
      lease({ id: "L4", status: "Cancelled", moveInDate: null, isCurrentLease: false }),
    ];
    const board = buildAgentBoard(leases, [], [], [], { windowMonths: 12, nowMs: NOW });
    expect(board.totalTenancies).toBe(2);
    expect(board.overallEvictionRate).toBe(0.5);
  });

  test("no tenancies at all is a rate of zero, not a divide by zero", () => {
    const board = buildAgentBoard(
      [lease({ id: "L1", moveInDate: null, isCurrentLease: false })],
      [], [], [],
      { windowMonths: 12, nowMs: NOW },
    );
    expect(board.totalTenancies).toBe(0);
    expect(board.overallEvictionRate).toBe(0);
  });

  /**
   * Unit 1732 ST-2: resident since 2020-07-20, renewed 2026-07-01 by an agent
   * three months into the job, first late that same month. Anchored on the
   * move-in it read as 72 months in — the "1yr+" bucket — so delinquency that
   * began weeks ago looked like inherited history. Anchored on the term it is
   * month 0, which is what actually happened.
   */
  test("a renewal's histogram measures from the renewal, not the original move-in", () => {
    const leases = [
      lease({
        id: "L1",
        leasingAgent: "KC",
        applicationDate: null,
        startDate: "2026-07-01",
        moveInDate: "2020-07-20",
        balance: 1907.6,
      }),
    ];
    const drill = agentDrillIn("KC", leases, [], [summary({ leaseId: "L1", firstLateMonth: "2026-07" })], []);
    expect(drill.histogram).toEqual([1, 0, 0, 0, 0, 0]);
  });

  test("a renewal's eviction row is dated by its term, not the original move-in", () => {
    const leases = [
      lease({
        id: "L1",
        leasingAgent: "KC",
        applicationDate: null,
        startDate: "2026-07-01",
        moveInDate: "2020-07-20",
        status: "Evicted",
        isCurrentLease: false,
      }),
    ];
    const drill = agentDrillIn("KC", leases, [], [], []);
    expect(drill.evictions[0].signed).toBe("2026-07-01");
  });

  test("balances group by tenure, keeping priority order inside each group", () => {
    const now = new Date(2026, 7, 15).getTime();
    const units = [
      unit({ unitId: "u1", unitNumber: "101", balance: 300, currentMonthBalance: 300, currentLeaseId: "L1" }),
      unit({ unitId: "u2", unitNumber: "102", balance: 4000, previousBalance: 4000, currentLeaseId: "L2" }),
      unit({ unitId: "u3", unitNumber: "103", balance: 900, previousBalance: 900, currentLeaseId: "L3" }),
      unit({ unitId: "u4", unitNumber: "104", balance: 50, currentMonthBalance: 50, currentLeaseId: "L4" }),
    ];
    const moveIn = new Map([
      ["u1", "2026-08-01"], // 14 days
      ["u2", "2026-07-20"], // 26 days — same band, bigger balance
      ["u3", "2020-07-20"], // six years
      // u4 deliberately absent: no move-in date known
    ]);
    const board = buildBalancesBoard(units, [], new Map(), now, moveIn);

    expect(board.tenureGroups.map((g) => g.bucket)).toEqual(["0-30", "1yr+", "unknown"]);
    // Priority order survives inside the band: the 90+ $4,000 outranks the
    // 0-30 $300 even though it is the newer resident of the two.
    expect(board.tenureGroups[0].rows.map((r) => r.unit.unitNumber)).toEqual(["102", "101"]);
    expect(board.tenureGroups[0].owed).toBe(4300);
    // Empty bands are dropped, but a missing move-in date must never hide a
    // debtor — it gets its own group instead.
    expect(board.tenureGroups[2].rows.map((r) => r.unit.unitNumber)).toEqual(["104"]);
    expect(board.rows).toHaveLength(4);
  });

  test("with no move-in dates at all, every row still appears under unknown", () => {
    const units = [unit({ unitId: "u1", unitNumber: "101", balance: 100, currentLeaseId: "L1" })];
    const board = buildBalancesBoard(units, [], new Map(), Date.now());
    expect(board.tenureGroups).toHaveLength(1);
    expect(board.tenureGroups[0].bucket).toBe("unknown");
    expect(board.tenureGroups[0].rows).toHaveLength(1);
  });

  test("the ledger timeline keeps ResMan's order for entries sharing a date", () => {
    // The running-balance column only reads as a tab if the rows stay in
    // ledger order. Several entries routinely share one date, and sorting
    // those by id put a rent charge above the late fee that followed it, so
    // the balance column appeared to jump backwards.
    const entries = [
      entry({ id: "e3", date: "2026-08-06", description: "Late Fee Charge", charges: 71.8, balance: 1907.6 }),
      entry({ id: "e1", date: "2026-08-01", description: "Rent Charge", charges: 718, balance: 1835.8 }),
      entry({ id: "e2", date: "2026-08-01", description: "Pest Control", charges: 3, balance: 1117.8 }),
    ];
    const timeline = buildTimeline(entries, [], "L1");
    expect(timeline.map((i) => (i.type === "ledger" ? i.entry.id : i.key))).toEqual(["e3", "e1", "e2"]);
    // Newest first, so the top row's balance is what is owed today.
    expect(timeline[0].type === "ledger" && timeline[0].entry.balance).toBe(1907.6);
  });

  test("firstLateDelayBucket maps month deltas to the six histogram buckets", () => {
    expect(firstLateDelayBucket(0)).toBe(0);
    expect(firstLateDelayBucket(1)).toBe(1);
    expect(firstLateDelayBucket(2)).toBe(2);
    expect(firstLateDelayBucket(3)).toBe(3);
    expect(firstLateDelayBucket(6)).toBe(3);
    expect(firstLateDelayBucket(7)).toBe(4);
    expect(firstLateDelayBucket(12)).toBe(4);
    expect(firstLateDelayBucket(13)).toBe(5);
  });

  test("drill-in collects the agent's evictions and first-late histogram", () => {
    // New tenancies, so the term starts the day they move in — the histogram
    // is anchored on startDate, and leaving these to the helper's 2024 default
    // would make them renewals a year and a half deep.
    const leases = [
      lease({ id: "L1", leasingAgent: "DJ", startDate: "2025-08-01", moveInDate: "2025-08-01", status: "Evicted", balance: 6940, isCurrentLease: false, unitNumber: "0288" }),
      lease({ id: "L2", leasingAgent: "DJ", startDate: "2026-02-01", moveInDate: "2026-02-01", balance: 1310 }),
      lease({ id: "L3", leasingAgent: "QH", startDate: "2026-01-01", moveInDate: "2026-01-01", status: "Evicted", isCurrentLease: false }),
    ];
    const summaries = [
      summary({ leaseId: "L1", firstLateMonth: "2025-10" }), // +2 months → bucket 2
      summary({ leaseId: "L2", firstLateMonth: "2026-06" }), // +4 months → bucket 3
    ];
    const drill = agentDrillIn("DJ", leases, [], summaries, []);
    expect(drill.evictions).toHaveLength(1);
    expect(drill.evictions[0].unitNumber).toBe("0288");
    expect(drill.histogram).toEqual([0, 0, 1, 1, 0, 0]);
    expect(drill.delinquentNow).toBe(1);
    expect(drill.openDelinquent).toBe(1310);
  });

  test("lastPaymentMap keeps only dated rows, date-only", () => {
    const map = lastPaymentMap([
      summary({ leaseId: "L1", lastPaymentDate: "2026-07-01T00:00:00Z" }),
      summary({ leaseId: "L2", lastPaymentDate: null }),
    ]);
    expect(map.get("L1")).toBe("2026-07-01");
    expect(map.has("L2")).toBe(false);
  });
});

// ---- timeline --------------------------------------------------------------

describe("buildTimeline", () => {
  test("interleaves ledger + actions newest first; actions win same-day ties", () => {
    const entries = [
      entry({ id: "jul", date: "2026-07-01", description: "July rent" }),
      entry({ id: "pay", date: "2026-06-24", charges: 0, credits: 250, description: "Payment" }),
    ];
    const actions = [
      action({ resmanLeaseId: "L1", kind: "notice_served", createdAt: "2026-07-01T09:00:00Z" }),
      action({ resmanLeaseId: "OTHER", kind: "called", createdAt: "2026-07-02T09:00:00Z" }),
    ];
    const timeline = buildTimeline(entries, actions, "L1");
    expect(timeline.map((i) => i.type)).toEqual(["action", "ledger", "ledger"]);
    expect(timeline[0].dateIso).toBe("2026-07-01");
    expect(timeline[2].key).toBe("l-pay");
  });

  test("skips undated rows", () => {
    const timeline = buildTimeline(
      [entry({ date: null })],
      [action({ resmanLeaseId: "L1", createdAt: null })],
      "L1",
    );
    expect(timeline).toHaveLength(0);
  });
});
