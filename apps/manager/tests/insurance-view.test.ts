/**
 * Insurance-compliance derived-engine tests. All fixtures flow through the
 * real zod schemas (InsurancePolicySchema / InsuranceActionSchema) so
 * defaults and coercions match production, against a fixed local-time "now"
 * so calendar math is deterministic.
 */

// TS 6 doesn't auto-include @types packages; pull in bun:test declarations.
/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import {
  InsuranceActionSchema,
  InsurancePolicySchema,
  type InsuranceAction,
  type InsurancePolicy,
} from "@/lib/api/insurance";
import {
  actionsByLease,
  buildInsuranceBoard,
  buildInsuranceMetrics,
  buildInsuranceTimeline,
  INSURANCE_EXPIRING_DAYS,
  insuranceRowView,
  insuranceStatus,
} from "@/lib/derived/insurance-view";
import { addDays, startOfDay } from "@/lib/derived/time";

// Tue 2026-07-21 noon, device-local.
const NOW = new Date("2026-07-21T12:00:00").getTime();

/** Local "YYYY-MM-DD" for a day offset from NOW. */
function day(offset: number): string {
  const d = new Date(startOfDay(addDays(NOW, offset)));
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** ISO timestamp (noon local) for a day offset from NOW. */
function stamp(offset: number): string {
  return new Date(addDays(NOW, offset)).toISOString();
}

let policySeq = 0;
function policy(fields: Partial<InsurancePolicy> = {}): InsurancePolicy {
  policySeq += 1;
  return InsurancePolicySchema.parse({
    leaseId: `lease-${policySeq}`,
    unitNumber: String(100 + policySeq),
    tenantNames: ["Marcus Sanders"],
    leaseStart: day(-400),
    policyId: `ins-${policySeq}`,
    provider: "Allstate",
    policyNumberLast4: "8820",
    policyType: "Renters liability",
    coverageAmount: 100000,
    startDate: day(-365),
    endDate: day(90),
    ...fields,
  });
}

/** A never-filed lease: all policy fields null. */
function neverFiled(fields: Partial<InsurancePolicy> = {}): InsurancePolicy {
  return policy({
    policyId: null,
    provider: null,
    policyNumberLast4: null,
    policyType: null,
    coverageAmount: null,
    startDate: null,
    endDate: null,
    ...fields,
  });
}

let actionSeq = 0;
function action(fields: Partial<InsuranceAction> = {}): InsuranceAction {
  actionSeq += 1;
  return InsuranceActionSchema.parse({
    id: `act-${actionSeq}`,
    resmanLeaseId: "lease-1",
    unitNumber: "0731",
    kind: "note",
    note: "",
    createdBy: "B. Bloch",
    createdAt: stamp(-1),
    ...fields,
  });
}

// ── Status: the date comparison ─────────────────────────────────────────────

describe("insuranceStatus", () => {
  test("no policy row → neverFiled", () => {
    expect(insuranceStatus(neverFiled(), NOW)).toBe("neverFiled");
  });

  test("end date in the past → lapsed (yesterday is already uninsured)", () => {
    expect(insuranceStatus(policy({ endDate: day(-1) }), NOW)).toBe("lapsed");
    expect(insuranceStatus(policy({ endDate: day(-110) }), NOW)).toBe("lapsed");
  });

  test("ending today or within 30 days → expiring; day 31 is covered", () => {
    expect(insuranceStatus(policy({ endDate: day(0) }), NOW)).toBe("expiring");
    expect(insuranceStatus(policy({ endDate: day(INSURANCE_EXPIRING_DAYS) }), NOW)).toBe(
      "expiring",
    );
    expect(insuranceStatus(policy({ endDate: day(INSURANCE_EXPIRING_DAYS + 1) }), NOW)).toBe(
      "covered",
    );
  });

  test("a policy on file with no end date has nothing to compare → covered", () => {
    expect(insuranceStatus(policy({ endDate: null }), NOW)).toBe("covered");
  });
});

// ── Row derivation ──────────────────────────────────────────────────────────

describe("insuranceRowView", () => {
  test("lapsed rows carry daysSinceLapse and the latest proof request", () => {
    const p = policy({ leaseId: "lease-x", endDate: day(-110) });
    const older = action({ resmanLeaseId: "lease-x", kind: "proof_requested", createdAt: stamp(-31) });
    const newer = action({ resmanLeaseId: "lease-x", kind: "proof_requested", createdAt: stamp(-5) });
    const other = action({ resmanLeaseId: "lease-x", kind: "second_notice", createdAt: stamp(-2) });
    const row = insuranceRowView(p, [other, newer, older], NOW);
    expect(row.status).toBe("lapsed");
    expect(row.daysSinceLapse).toBe(110);
    expect(row.daysLeft).toBeNull();
    expect(row.lastProofRequest?.id).toBe(newer.id);
    expect(row.daysSinceRequest).toBe(5);
  });

  test("expiring rows carry daysLeft; no requests → no chip data", () => {
    const row = insuranceRowView(policy({ endDate: day(9) }), [], NOW);
    expect(row.status).toBe("expiring");
    expect(row.daysLeft).toBe(9);
    expect(row.daysSinceLapse).toBeNull();
    expect(row.lastProofRequest).toBeNull();
    expect(row.daysSinceRequest).toBeNull();
  });

  test("never-filed rows keep the move-in context and first tenant name", () => {
    const row = insuranceRowView(
      neverFiled({ leaseStart: day(-30), tenantNames: ["Asha Patel", "Dev Patel"] }),
      [],
      NOW,
    );
    expect(row.status).toBe("neverFiled");
    expect(row.leaseStartMs).toBe(startOfDay(addDays(NOW, -30)));
    expect(row.tenantName).toBe("Asha Patel");
  });
});

// ── Board: bands, distribution, metrics ─────────────────────────────────────

describe("buildInsuranceBoard", () => {
  const fixtures = [
    policy({ leaseId: "l-lapsed-old", unitNumber: "0731", endDate: day(-110) }),
    policy({ leaseId: "l-lapsed-new", unitNumber: "0455", endDate: day(-33) }),
    policy({ leaseId: "l-exp-9", unitNumber: "0327", endDate: day(9) }),
    policy({ leaseId: "l-exp-2", unitNumber: "0815", endDate: day(2) }),
    policy({ leaseId: "l-covered", unitNumber: "0644", endDate: day(200) }),
    neverFiled({ leaseId: "l-never-b", unitNumber: "0920" }),
    neverFiled({ leaseId: "l-never-a", unitNumber: "0919" }),
  ];

  test("bands sort per the mockup: lapsed by days desc, expiring soonest first, never filed by unit", () => {
    const board = buildInsuranceBoard(fixtures, [], NOW);
    expect(board.lapsed.map((r) => r.policy.leaseId)).toEqual(["l-lapsed-old", "l-lapsed-new"]);
    expect(board.expiring.map((r) => r.policy.leaseId)).toEqual(["l-exp-2", "l-exp-9"]);
    expect(board.neverFiled.map((r) => r.policy.unitNumber)).toEqual(["0919", "0920"]);
  });

  test("distribution counts the four segments and needsAction excludes never filed", () => {
    const board = buildInsuranceBoard(fixtures, [], NOW);
    expect(board.distribution).toEqual({
      covered: 1,
      expiring: 2,
      lapsed: 2,
      none: 2,
      total: 7,
    });
    expect(board.needsAction).toBe(4);
    expect(board.expiringWeek).toBe(1); // only the 2-day policy is inside the week
    expect(board.coveredToday).toBe(3); // covered + expiring still have coverage today
    expect(board.coveredPct).toBeCloseTo((3 / 7) * 100, 5);
  });

  test("metrics carry the i18n keys and counts", () => {
    const metrics = buildInsuranceMetrics(buildInsuranceBoard(fixtures, [], NOW));
    expect(metrics.map((m) => m.key)).toEqual(["covered", "lapsed", "expiring"]);
    expect(metrics[0].value).toBe("42.9%");
    expect(metrics[0].captionParams).toEqual({ covered: 3, total: 7 });
    expect(metrics[1].value).toBe("2");
    expect(metrics[2].value).toBe("2");
    expect(metrics[2].captionParams).toEqual({ week: 1 });
  });

  test("an empty property yields a calm zero board", () => {
    const board = buildInsuranceBoard([], [], NOW);
    expect(board.total).toBe(0);
    expect(board.coveredPct).toBe(0);
    expect(board.needsAction).toBe(0);
  });
});

// ── Timeline: derived lapse entry interleaved with stored actions ───────────

describe("buildInsuranceTimeline", () => {
  test("lapse-detected is derived at end date + 1 and interleaves newest first", () => {
    const p = policy({ leaseId: "l-1", endDate: day(-110) });
    const acts = [
      action({ resmanLeaseId: "l-1", kind: "proof_requested", createdAt: stamp(-13) }),
      action({ resmanLeaseId: "l-1", kind: "second_notice", createdAt: stamp(-31) }),
    ];
    const row = insuranceRowView(p, acts, NOW);
    const timeline = buildInsuranceTimeline(row, acts);
    expect(timeline.map((i) => i.kind)).toEqual(["action", "action", "lapseDetected"]);
    const lapse = timeline[2];
    if (lapse.kind !== "lapseDetected") throw new Error("expected lapseDetected");
    expect(lapse.whenMs).toBe(addDays(startOfDay(addDays(NOW, -110)), 1));
  });

  test("no lapse entry while the policy is not lapsed, or when never filed", () => {
    const covered = insuranceRowView(policy({ endDate: day(90) }), [], NOW);
    expect(buildInsuranceTimeline(covered, []).length).toBe(0);
    const never = insuranceRowView(neverFiled(), [], NOW);
    expect(buildInsuranceTimeline(never, []).length).toBe(0);
  });
});

// ── Actions index ───────────────────────────────────────────────────────────

describe("actionsByLease", () => {
  test("groups per lease, newest first", () => {
    const a1 = action({ resmanLeaseId: "l-1", createdAt: stamp(-10) });
    const a2 = action({ resmanLeaseId: "l-1", createdAt: stamp(-2) });
    const b1 = action({ resmanLeaseId: "l-2", createdAt: stamp(-5) });
    const map = actionsByLease([a1, b1, a2]);
    expect(map.get("l-1")?.map((a) => a.id)).toEqual([a2.id, a1.id]);
    expect(map.get("l-2")?.length).toBe(1);
  });
});
