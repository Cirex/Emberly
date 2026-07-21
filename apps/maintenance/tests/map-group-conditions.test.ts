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
  buildConditionVocabulary,
  conditionSummary,
  defaultConditionFor,
} from "@/lib/map-group-conditions";

const EMPTY_VOCAB = { availabilities: [], classifications: [], layouts: [] };

function groupWith(conditions: GroupCondition[]): MapFilterGroup {
  return { id: "g", name: "G", colorHex: "#112233", conditions, visible: true };
}

const NOW = new Date(2026, 6, 21, 12).getTime();

describe("condition kind vocabulary", () => {
  test("every default is a live, evaluable condition of its own kind", () => {
    for (const kind of CONDITION_KINDS) {
      const cond = defaultConditionFor(kind, EMPTY_VOCAB);
      expect(cond.kind).toBe(kind);
      // The engine must accept it without throwing — evaluate against a unit.
      const unit = { number: "101", occupancy_status: "Occupied", lease_status: "Current" };
      expect(typeof unitMatchesGroup(unit, groupWith([cond]), NOW)).toBe("boolean");
    }
  });

  test("data-driven defaults use the first synced value, with fallbacks", () => {
    const vocab = {
      availabilities: ["Leased", "Ready"],
      classifications: ["Diamond", "Ruby"],
      layouts: ["1x1", "2x1.5"],
    };
    expect(defaultConditionFor("availabilityIn", vocab)).toEqual({ kind: "availabilityIn", values: ["Leased"] });
    expect(defaultConditionFor("classificationIn", vocab)).toEqual({ kind: "classificationIn", values: ["Diamond"] });
    expect(defaultConditionFor("layoutIn", vocab)).toEqual({ kind: "layoutIn", values: ["1x1"] });
    expect(defaultConditionFor("availabilityIn", EMPTY_VOCAB)).toEqual({ kind: "availabilityIn", values: ["Available"] });
    expect(defaultConditionFor("layoutIn", EMPTY_VOCAB)).toEqual({ kind: "layoutIn", values: ["1x1"] });
  });
});

describe("buildConditionVocabulary", () => {
  test("dedupes case-insensitively, trims, drops blanks, sorts each list", () => {
    const units = [
      { number: "1", availability: " Ready ", classification: "Ruby", bedrooms: 2, bathrooms: 1.5 },
      { number: "2", availability: "ready", classification: "ruby", bedrooms: 1, bathrooms: 1 },
      { number: "3", availability: "Available", classification: "Diamond", bedrooms: 2, bathrooms: 1.5 },
      { number: "4", availability: "", classification: null, bedrooms: 10, bathrooms: null },
      { number: "5" },
    ];
    const vocab = buildConditionVocabulary(units);
    expect(vocab.availabilities).toEqual(["Available", "Ready"]);
    expect(vocab.classifications).toEqual(["Diamond", "Ruby"]);
    // Missing bath count on unit 4 → no layout contributed.
    expect(vocab.layouts).toEqual(["1x1", "2x1.5"]);
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
    expect(conditionSummary({ kind: "classificationIn", values: ["Diamond", "Ruby"] })).toEqual({
      key: "classificationIn",
      params: { values: "Diamond, Ruby" },
    });
    expect(conditionSummary({ kind: "layoutIn", values: ["2x1.5"] })).toEqual({
      key: "layoutIn",
      params: { values: "2x1.5" },
    });
    expect(conditionSummary({ kind: "evictionFlag" })).toEqual({ key: "evictionFlag" });
  });
});
