/**
 * Utility-layer tests: the server-row ↔ MapAnnotation mapping (kind /
 * utilityType / points round-trip per the map-annotation contract) and the
 * pure line hit-test the canvas taps run through.
 */

// TS 6 doesn't auto-include @types packages; pull in bun:test declarations.
/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import { RemoteAnnotationSchema, type RemoteAnnotation } from "@/lib/api/annotations";
import { fromRemote, toFields, type MapAnnotation } from "@/lib/annotation-mapping";
import {
  UTILITY_LINE_HIT_PX,
  distToSegmentSq,
  effectiveLineStyle,
  effectiveLineWeight,
  flowChevrons,
  hitTestUtilityLines,
  polylineLengthPx,
  polylineMidpoint,
} from "@/lib/utility-lines";

function remote(fields: Partial<RemoteAnnotation> = {}): RemoteAnnotation {
  return RemoteAnnotationSchema.parse({
    id: "srv-1",
    title: "",
    notes: "",
    normalizedX: 0.25,
    normalizedY: 0.5,
    colorHex: "#2563B4",
    icon: "construct",
    createdByDisplayName: null,
    updatedAt: null,
    deletedAt: null,
    version: 3,
    ...fields,
  });
}

describe("RemoteAnnotationSchema", () => {
  test("defaults missing kind fields to a plain pin (pre-utility server)", () => {
    const r = remote();
    expect(r.kind).toBe("pin");
    expect(r.utilityType).toBeNull();
    expect(r.points).toBeNull();
  });

  test("tolerates an unknown future kind by falling back to pin", () => {
    expect(remote({ kind: "utility_polygon" as never }).kind).toBe("pin");
  });

  test("parses utility fields when present", () => {
    const r = remote({
      kind: "utility_line",
      utilityType: "sewer",
      points: [
        { x: 0.25, y: 0.5 },
        { x: 0.3, y: 0.6 },
      ],
    });
    expect(r.kind).toBe("utility_line");
    expect(r.utilityType).toBe("sewer");
    expect(r.points).toHaveLength(2);
  });
});

describe("server row -> MapAnnotation -> payload round-trip", () => {
  test("plain pin maps as before and sends null utility fields", () => {
    const a = fromRemote(remote({ id: "pin-1", title: "Note", colorHex: "#A2A921", icon: "trash" }));
    expect(a).toMatchObject({ id: "pin-1", kind: "pin", x: 0.25, y: 0.5, version: 3 });
    expect(a.utilityType).toBeUndefined();
    expect(a.points).toBeUndefined();
    expect(toFields(a)).toEqual({
      title: "Note",
      notes: "",
      normalizedX: 0.25,
      normalizedY: 0.5,
      colorHex: "#A2A921",
      icon: "trash",
      kind: "pin",
      utilityType: null,
      points: null,
      lineStyle: null,
      lineWeight: null,
      flowArrows: null,
    });
  });

  test("utility_line round-trips kind, type, and vertices", () => {
    const points = [
      { x: 0.1, y: 0.2 },
      { x: 0.4, y: 0.2 },
      { x: 0.4, y: 0.7 },
    ];
    const a = fromRemote(
      remote({ id: "line-1", kind: "utility_line", utilityType: "water", points, normalizedX: 0.1, normalizedY: 0.2 }),
    );
    expect(a.kind).toBe("utility_line");
    expect(a.utilityType).toBe("water");
    expect(a.points).toEqual(points);

    const fields = toFields(a);
    expect(fields.kind).toBe("utility_line");
    expect(fields.utilityType).toBe("water");
    expect(fields.points).toEqual(points);
    // Columns stay NOT NULL server-side: the anchor rides the first vertex.
    expect(fields.normalizedX).toBe(0.1);
    expect(fields.normalizedY).toBe(0.2);
  });

  test("utility_pin round-trips its type with no points", () => {
    const a = fromRemote(remote({ id: "upin-1", kind: "utility_pin", utilityType: "gas" }));
    expect(a.kind).toBe("utility_pin");
    const fields = toFields(a);
    expect(fields.kind).toBe("utility_pin");
    expect(fields.utilityType).toBe("gas");
    expect(fields.points).toBeNull();
  });

  test("a row persisted before the utility layer (no kind) still sends a pin payload", () => {
    const legacy = {
      id: "local-1",
      x: 0.5,
      y: 0.5,
      title: "",
      notes: "",
      color: "#A2A921",
      icon: "",
      version: 0,
    } as MapAnnotation;
    const fields = toFields(legacy);
    expect(fields.kind).toBe("pin");
    expect(fields.utilityType).toBeNull();
    expect(fields.points).toBeNull();
    expect(fields.icon).toBe("document-text");
  });

  test("stray points/utilityType on a non-line kind are nulled in the payload", () => {
    const odd = {
      id: "x",
      x: 0,
      y: 0,
      title: "",
      notes: "",
      color: "#888780",
      icon: "construct",
      kind: "pin",
      utilityType: "water",
      points: [{ x: 0, y: 0 }],
      version: 1,
    } as MapAnnotation;
    const fields = toFields(odd);
    expect(fields.utilityType).toBeNull();
    expect(fields.points).toBeNull();
  });
});

describe("run presentation fields", () => {
  test("schema defaults absent style fields to null (older server)", () => {
    const r = remote({ kind: "utility_line", utilityType: "water", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
    expect(r.lineStyle).toBeNull();
    expect(r.lineWeight).toBeNull();
    expect(r.flowArrows).toBeNull();
  });

  test("style fields round-trip through the mapping", () => {
    const r = remote({
      kind: "utility_line",
      utilityType: "water",
      points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      lineStyle: "dotted",
      lineWeight: "thick",
      flowArrows: true,
    });
    const a = fromRemote(r);
    expect(a.lineStyle).toBe("dotted");
    expect(a.lineWeight).toBe("thick");
    expect(a.flowArrows).toBe(true);
    const fields = toFields(a);
    expect(fields.lineStyle).toBe("dotted");
    expect(fields.lineWeight).toBe("thick");
    expect(fields.flowArrows).toBe(true);
  });

  test("stray style fields on a non-line kind are nulled in the payload", () => {
    const odd = fromRemote(remote({ kind: "utility_pin", utilityType: "gas" }));
    const fields = toFields({ ...odd, lineStyle: "dashed", flowArrows: true });
    expect(fields.lineStyle).toBeNull();
    expect(fields.flowArrows).toBeNull();
  });

  test("effective style keeps the pre-style type defaults", () => {
    expect(effectiveLineStyle({ utilityType: "sewer" })).toBe("dashed");
    expect(effectiveLineStyle({ utilityType: "gas" })).toBe("dotted");
    expect(effectiveLineStyle({ utilityType: "water" })).toBe("solid");
    expect(effectiveLineStyle({ utilityType: "electrical" })).toBe("solid");
    // A stored style beats the type default.
    expect(effectiveLineStyle({ utilityType: "sewer", lineStyle: "solid" })).toBe("solid");
    expect(effectiveLineWeight({})).toBe("medium");
    expect(effectiveLineWeight({ lineWeight: "thin" })).toBe("thin");
  });
});

describe("run geometry", () => {
  const PAGE = 1000;
  const L = [
    { x: 0.1, y: 0.5 },
    { x: 0.5, y: 0.5 },
    { x: 0.5, y: 0.9 },
  ];

  test("polylineLengthPx sums the segments", () => {
    expect(polylineLengthPx(L, PAGE, PAGE)).toBe(800);
    expect(polylineLengthPx([L[0]], PAGE, PAGE)).toBe(0);
  });

  test("midpoint lands at half the arc length, on the path", () => {
    // Total 800 → midpoint 400 in: 400 along the first (horizontal) segment.
    expect(polylineMidpoint(L, PAGE, PAGE)).toEqual({ x: 500, y: 500 });
    expect(polylineMidpoint([L[0]], PAGE, PAGE)).toBeNull();
  });

  test("chevrons repeat along the run and point forward", () => {
    const chevs = flowChevrons(L, PAGE, PAGE, 200, 10);
    // 800 arc length, first at 100 then every 200 → 100, 300, 500, 700.
    expect(chevs).toHaveLength(4);
    // First chevron sits on the horizontal segment, tip further along +x.
    const first = chevs[0];
    expect(first.tipY).toBeCloseTo(500);
    expect(first.tipX).toBeGreaterThan(first.leftX);
    expect(first.tipX).toBeGreaterThan(first.rightX);
    // Last chevron is on the vertical segment, pointing down (+y).
    const last = chevs[3];
    expect(last.tipX).toBeCloseTo(500);
    expect(last.tipY).toBeGreaterThan(last.leftY);
    // Reversing the points reverses the tips.
    const rev = flowChevrons([...L].reverse(), PAGE, PAGE, 200, 10);
    expect(rev[0].tipY).toBeLessThan(rev[0].leftY);
  });

  test("a degenerate run (all points equal) yields no chevrons", () => {
    expect(flowChevrons([{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }], PAGE, PAGE)).toEqual([]);
  });

  test("a short run still gets one mid-run chevron", () => {
    const short = flowChevrons([{ x: 0.5, y: 0.5 }, { x: 0.56, y: 0.5 }], PAGE, PAGE, 220, 13);
    expect(short).toHaveLength(1);
    expect(short[0].tipY).toBeCloseTo(500);
  });
});

describe("distToSegmentSq", () => {
  test("measures perpendicular distance inside the segment span", () => {
    expect(distToSegmentSq(5, 3, 0, 0, 10, 0)).toBe(9);
  });

  test("measures to the nearest endpoint beyond the span", () => {
    expect(distToSegmentSq(-3, 4, 0, 0, 10, 0)).toBe(25);
  });

  test("treats a degenerate (repeated-vertex) segment as a point", () => {
    expect(distToSegmentSq(3, 4, 1, 1, 1, 1)).toBe(2 * 2 + 3 * 3);
  });
});

describe("hitTestUtilityLines", () => {
  const PAGE_W = 1000;
  const PAGE_H = 1000;
  // A horizontal water run across the page at y=500 and a vertical gas run.
  const lines = [
    {
      id: "water-run",
      kind: "utility_line",
      points: [
        { x: 0.1, y: 0.5 },
        { x: 0.9, y: 0.5 },
      ],
    },
    {
      id: "gas-run",
      kind: "utility_line",
      points: [
        { x: 0.5, y: 0.1 },
        { x: 0.5, y: 0.9 },
      ],
    },
  ];

  test("hits a run within the threshold", () => {
    expect(hitTestUtilityLines(lines, 300, 500 + UTILITY_LINE_HIT_PX - 1, PAGE_W, PAGE_H)).toBe("water-run");
  });

  test("misses beyond the threshold", () => {
    expect(hitTestUtilityLines(lines, 300, 500 + UTILITY_LINE_HIT_PX + 1, PAGE_W, PAGE_H)).toBeUndefined();
  });

  test("the nearest run wins where two runs come close", () => {
    // Near the crossing at (500,500): 10px off the water run, 30px off the gas run.
    expect(hitTestUtilityLines(lines, 470, 510, PAGE_W, PAGE_H)).toBe("water-run");
    expect(hitTestUtilityLines(lines, 510, 470, PAGE_W, PAGE_H)).toBe("gas-run");
  });

  test("ignores pins, utility pins, and degenerate one-point lines", () => {
    const noise = [
      { id: "p", kind: "pin" },
      { id: "up", kind: "utility_pin", points: null },
      { id: "one", kind: "utility_line", points: [{ x: 0.3, y: 0.5 }] },
    ];
    expect(hitTestUtilityLines(noise, 300, 500, PAGE_W, PAGE_H)).toBeUndefined();
  });
});
