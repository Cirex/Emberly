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
import { UTILITY_LINE_HIT_PX, distToSegmentSq, hitTestUtilityLines } from "@/lib/utility-lines";

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
