import { describe, expect, test } from "bun:test";
import { buildGroupPaint, withAlpha, EVICTION_HEAT_COLOR, type GroupUnit } from "@emberly/core";
import { HEAT_FILL_ALPHA, buildHeatPaint, hasEvictionSignal, heatTint } from "@/components/map/heat";
import { defaultManagerMapGroups } from "@/components/map/groups-defaults";

/** A synced unit with only the fields the lenses read. */
function unit(partial: Partial<GroupUnit> & { number: string }): GroupUnit {
  return { occupancy_status: "Occupied", lease_status: "Current", balance: 0, ...partial };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

describe("heat lens", () => {
  test("eviction signal reads lease/occupancy status and delinquency_reason", () => {
    expect(hasEvictionSignal(unit({ number: "1", lease_status: "Under Eviction" }))).toBe(true);
    expect(hasEvictionSignal(unit({ number: "2", occupancy_status: "Under Eviction" }))).toBe(true);
    // The manager DTO has no delinquency_reason yet, but the signal is ready for it.
    expect(hasEvictionSignal(unit({ number: "3", delinquency_reason: "Skips" }))).toBe(true);
    expect(hasEvictionSignal(unit({ number: "4" }))).toBe(false);
    expect(hasEvictionSignal(unit({ number: "5", delinquency_reason: "   " }))).toBe(false);
  });

  test("current units are unpainted; balances grade through the ramp", () => {
    const { colorMap } = buildHeatPaint([
      unit({ number: "A", balance: 0 }),
      unit({ number: "B", balance: -50 }),
      unit({ number: "C", balance: 120 }),
      unit({ number: "D", balance: 2200 }),
    ]);
    expect(colorMap.has("A")).toBe(false);
    expect(colorMap.has("B")).toBe(false);
    expect(colorMap.get("C")).toEqual({ fill: withAlpha("#F8E7C8", HEAT_FILL_ALPHA), stroke: "#F8E7C8" });
    expect(colorMap.get("D")).toEqual({ fill: withAlpha("#D1382E", HEAT_FILL_ALPHA), stroke: "#D1382E" });
  });

  test("eviction overrides the ramp, even at zero balance", () => {
    const { colorMap, delinquentCount, evictionCount } = buildHeatPaint([
      unit({ number: "E", balance: 0, lease_status: "Under Eviction" }),
      unit({ number: "F", balance: 900, lease_status: "Under Eviction" }),
      unit({ number: "G", balance: 900 }),
    ]);
    expect(colorMap.get("E")?.stroke).toBe(EVICTION_HEAT_COLOR);
    expect(colorMap.get("F")?.stroke).toBe(EVICTION_HEAT_COLOR);
    expect(colorMap.get("G")?.stroke).toBe("#E88A5E");
    expect(delinquentCount).toBe(2); // F and G owe; E is eviction-only
    expect(evictionCount).toBe(2);
  });

  test("heatTint mirrors the paint decision for the callout", () => {
    expect(heatTint(unit({ number: "H", balance: 0 }))).toBeUndefined();
    expect(heatTint(unit({ number: "I", balance: 1600 }))).toBe("#D1382E");
    expect(heatTint(unit({ number: "J", lease_status: "Under Eviction" }))).toBe(EVICTION_HEAT_COLOR);
  });
});

describe("manager default groups", () => {
  const groups = defaultManagerMapGroups();
  const byName = (name: string) => {
    const g = groups.find((x) => x.name === name);
    if (!g) throw new Error(`missing default group ${name}`);
    return g;
  };

  test("ships the leasing set (applicant group deliberately absent)", () => {
    expect(groups.map((g) => g.name)).toEqual([
      "Vacant ready",
      "Lease ends 30d",
      "Eviction",
      "Balance > $800",
    ]);
    expect(groups.every((g) => g.visible)).toBe(true);
  });

  test("Vacant ready requires vacancy AND Ready availability", () => {
    const vacantReady = unit({ number: "1", occupancy_status: "Vacant", availability: "Ready" });
    const vacantDown = unit({ number: "2", occupancy_status: "Vacant", availability: "Not Ready" });
    const occupiedReady = unit({ number: "3", occupancy_status: "Occupied", availability: "Ready" });
    const { counts } = buildGroupPaint(groups, [vacantReady, vacantDown, occupiedReady], NOW);
    expect(counts.get(byName("Vacant ready").id)).toBe(1);
  });

  test("Balance > $800 is an exclusive-min band with no ceiling", () => {
    const { counts } = buildGroupPaint(
      groups,
      [
        unit({ number: "1", balance: 800 }),
        unit({ number: "2", balance: 800.01 }),
        unit({ number: "3", balance: 25_000 }),
      ],
      NOW,
    );
    expect(counts.get(byName("Balance > $800").id)).toBe(2);
  });

  test("first visible match paints; counts still include hidden groups", () => {
    // Under eviction AND owing > $800: Eviction sits above Balance > $800.
    const both = unit({ number: "9", lease_status: "Under Eviction", balance: 1200 });
    const painted = buildGroupPaint(groups, [both], NOW);
    expect(painted.colorMap.get("9")?.fill).toBe(withAlpha("#7A1F1F", 0.4));
    expect(painted.counts.get(byName("Eviction").id)).toBe(1);
    expect(painted.counts.get(byName("Balance > $800").id)).toBe(1);

    // Hide Eviction: the paint falls to the balance group, the count remains.
    const hidden = groups.map((g) => (g.name === "Eviction" ? { ...g, visible: false } : g));
    const repainted = buildGroupPaint(hidden, [both], NOW);
    expect(repainted.colorMap.get("9")?.fill).toBe(withAlpha("#D1382E", 0.4));
    expect(repainted.counts.get(byName("Eviction").id)).toBe(1);
  });

  test("Lease ends 30d matches inside the window only", () => {
    const soon = new Date(NOW + 10 * DAY_MS).toISOString().slice(0, 10);
    const far = new Date(NOW + 60 * DAY_MS).toISOString().slice(0, 10);
    const { counts } = buildGroupPaint(
      groups,
      [unit({ number: "1", lease_end_date: soon }), unit({ number: "2", lease_end_date: far })],
      NOW,
    );
    expect(counts.get(byName("Lease ends 30d").id)).toBe(1);
  });
});
