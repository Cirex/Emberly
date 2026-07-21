import type {
  AnnotationFields,
  AnnotationKind,
  LineStyle,
  LineWeight,
  RemoteAnnotation,
  UtilityPoint,
  UtilityType,
} from "@/lib/api/annotations";

/**
 * The map-annotation domain model and its server-row mapping, kept pure
 * (no store, no storage) so the wire round-trip is unit-testable. The store
 * in lib/stores/annotations.ts owns persistence and sync on top of this.
 */

/**
 * A map annotation (normalized 0–1 coordinates), shared with the admin
 * portal's layered annotation channel. A plain pin ('pin'), a utility pin
 * ('utility_pin'), or a drawn utility polyline ('utility_line').
 */
export interface MapAnnotation {
  id: string;
  /** Anchor point; for a utility_line this mirrors the first vertex. */
  x: number;
  y: number;
  title: string;
  notes: string;
  color: string;
  /** Ionicons glyph shown on the pin. */
  icon: string;
  /** What the row is; rows persisted before the utility layer default 'pin'. */
  kind: AnnotationKind;
  /** Set exactly when kind is a utility kind. */
  utilityType?: UtilityType;
  /** Vertices of a drawn run — set exactly when kind is 'utility_line'. */
  points?: UtilityPoint[];
  /**
   * Per-run presentation, 'utility_line' only. Absent means "type default"
   * (sewer dashed, gas dotted, others solid; medium; no arrows) so runs drawn
   * before these fields render exactly as before. The label rides `title`.
   */
  lineStyle?: LineStyle;
  lineWeight?: LineWeight;
  flowArrows?: boolean;
  /** Server row version; 0 until the row has been accepted by the server. */
  version: number;
  /** Local changes not yet pushed. */
  dirty?: boolean;
  /** Deleted locally; awaiting the server round-trip. Hidden from the UI. */
  removed?: boolean;
}

export function isUtilityAnnotation(a: Pick<MapAnnotation, "kind">): boolean {
  return a.kind === "utility_pin" || a.kind === "utility_line";
}

export function fromRemote(r: RemoteAnnotation): MapAnnotation {
  return {
    id: r.id,
    x: r.normalizedX,
    y: r.normalizedY,
    title: r.title,
    notes: r.notes,
    color: r.colorHex,
    icon: r.icon,
    kind: r.kind,
    utilityType: r.utilityType ?? undefined,
    points: r.kind === "utility_line" && r.points ? r.points : undefined,
    lineStyle: (r.kind === "utility_line" && r.lineStyle) || undefined,
    lineWeight: (r.kind === "utility_line" && r.lineWeight) || undefined,
    flowArrows: (r.kind === "utility_line" && r.flowArrows) || undefined,
    version: r.version,
  };
}

export function toFields(a: MapAnnotation): AnnotationFields {
  // Rows persisted on-device before the utility layer carry no kind.
  const kind = a.kind ?? "pin";
  return {
    title: a.title,
    notes: a.notes,
    // The server keeps normalized_x/y NOT NULL for every kind; for a line the
    // creation helpers anchor these on the first vertex.
    normalizedX: a.x,
    normalizedY: a.y,
    colorHex: a.color,
    icon: a.icon || "document-text",
    kind,
    // The contract is strict both ways: utilityType required iff a utility
    // kind, points required iff a line — null everywhere else.
    utilityType: kind === "utility_pin" || kind === "utility_line" ? (a.utilityType ?? null) : null,
    points: kind === "utility_line" ? (a.points ?? null) : null,
    lineStyle: kind === "utility_line" ? (a.lineStyle ?? null) : null,
    lineWeight: kind === "utility_line" ? (a.lineWeight ?? null) : null,
    flowArrows: kind === "utility_line" ? (a.flowArrows ?? null) : null,
  };
}
