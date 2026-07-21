/**
 * The color-group condition builder's pure vocabulary: kind list parity with
 * the engine, per-kind defaults, availability vocabulary extraction, and the
 * i18n summaries the rows render.
 */

// TS 6 doesn't auto-include @types packages; pull in bun:test declarations.
/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import { unitMatchesGroup, type GroupCondition, type MapFilterGroup } from "@emberly/core";
import {
  CONDITION_KINDS,
  conditionSummary,
  defaultConditionFor,
  distinctAvailabilities,
} from "@/lib/map-group-conditions";

function groupWith(conditions: GroupCondition[]): MapFilterGroup {
  return { id: "g", name: "G", colorHex: "#112233", conditions, visible: true };
}

const NOW = new Date(2026, 6, 21, 12).getTime();

describe("condition kind vocabulary", () => {
  test("every default is a live, evaluable condition of its own kind", () => {
    for (const kind of CONDITION_KINDS) {
      const cond = defaultConditionFor(kind, ["Available"]);
      expect(cond.kind).toBe(kind);
      // The engine must accept it without throwing — evaluate against a unit.
      const unit = { number: "101", occupancy_status: "Occupied", lease_status: "Current" };
      expect(typeof unitMatchesGroup(unit, groupWith([cond]), NOW)).toBe("boolean");
    }
  });

  test("availability default uses the first synced value, with a fallback", () => {
    expect(defaultConditionFor("availabilityIn", ["Leased", "Ready"])).toEqual({
      kind: "availabilityIn",
      values: ["Leased"],
    });
    expect(defaultConditionFor("availabilityIn", [])).toEqual({
      kind: "availabilityIn",
      values: ["Available"],
    });
  });
});

describe("distinctAvailabilities", () => {
  test("dedupes case-insensitively, trims, drops blanks, sorts", () => {
    const units = [
      { availability: " Ready " },
      { availability: "ready" },
      { availability: "Available" },
      { availability: "" },
      { availability: null },
      {},
      { availability: "Leased - Not Yet Moved In" },
    ];
    expect(distinctAvailabilities(units)).toEqual(["Available", "Leased - Not Yet Moved In", "Ready"]);
  });
});

describe("conditionSummary", () => {
  test("maps every kind to its i18n key and params", () => {
    expect(conditionSummary({ kind: "occupancy", value: "Vacant" })).toEqual({
      key: "occupancy",
      params: { value: "Vacant" },
    });
    expect(conditionSummary({ kind: "balanceOverZero" })).toEqual({ key: "balanceOverZero" });
    expect(conditionSummary({ kind: "balanceBand", min: 300, max: 800 })).toEqual({
      key: "balanceBand",
      params: { min: 300, max: 800 },
    });
    // Open-ended band reads as "over $min".
    expect(conditionSummary({ kind: "balanceBand", min: 1500, max: null })).toEqual({
      key: "balanceOver",
      params: { min: 1500 },
    });
    expect(conditionSummary({ kind: "leaseEndsWithin", days: 60 })).toEqual({
      key: "leaseEndsWithin",
      params: { count: 60 },
    });
    expect(conditionSummary({ kind: "availabilityIn", values: ["Ready", "Available"] })).toEqual({
      key: "availabilityIn",
      params: { values: "Ready, Available" },
    });
    expect(conditionSummary({ kind: "evictionFlag" })).toEqual({ key: "evictionFlag" });
  });
});
