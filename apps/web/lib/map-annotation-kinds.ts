/**
 * Utility-layer annotation kinds, shared by every map-annotation door (the
 * external XCMS sync client, the admin portal, and the scanner iPads).
 *
 * A row is a plain pin ('pin'), a utility pin ('utility_pin'), or a drawn
 * utility polyline ('utility_line' — sewer/water/gas runs). Utility kinds
 * always live on the 'utility' layer, which both the staff and security
 * surfaces can see; plain pins keep their surface's own layer.
 */
import { z } from "zod";

export const ANNOTATION_KINDS = ["pin", "utility_pin", "utility_line"] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

export const UTILITY_TYPES = ["water", "sewer", "gas", "electrical", "other"] as const;
export type UtilityType = (typeof UTILITY_TYPES)[number];

/**
 * Per-run presentation for kind='utility_line'. Null means "type default" —
 * the renderers fall back to the pre-style behavior (sewer dashed, gas
 * dotted, others solid; medium weight; no arrows), so rows and clients that
 * predate these fields are unaffected. The run's label rides `title`, and
 * direction is the order of `points` (reversing a run rewrites the array).
 */
export const LINE_STYLES = ["solid", "dashed", "dotted"] as const;
export type LineStyle = (typeof LINE_STYLES)[number];

export const LINE_WEIGHTS = ["thin", "medium", "thick"] as const;
export type LineWeight = (typeof LINE_WEIGHTS)[number];

/** One vertex of a drawn utility run, normalized 0..1 to the map image. */
export const UtilityPointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export type UtilityPoint = z.infer<typeof UtilityPointSchema>;

export function isUtilityKind(kind: AnnotationKind | undefined): kind is "utility_pin" | "utility_line" {
  return kind === "utility_pin" || kind === "utility_line";
}

/**
 * Body fields to spread into a create/update Zod schema. `kind` defaults to
 * 'pin', so requests from clients that predate the utility layer parse exactly
 * as before.
 */
export const annotationKindFields = {
  kind: z.enum(ANNOTATION_KINDS).optional().default("pin"),
  utilityType: z.enum(UTILITY_TYPES).nullish(),
  points: z.array(UtilityPointSchema).min(2).max(200).nullish(),
  lineStyle: z.enum(LINE_STYLES).nullish(),
  lineWeight: z.enum(LINE_WEIGHTS).nullish(),
  flowArrows: z.boolean().nullish(),
};

export interface AnnotationKindInput {
  kind: AnnotationKind;
  utilityType?: UtilityType | null;
  points?: UtilityPoint[] | null;
  lineStyle?: LineStyle | null;
  lineWeight?: LineWeight | null;
  flowArrows?: boolean | null;
}

/**
 * superRefine hook enforcing the cross-field contract:
 *   - utilityType is required iff kind is 'utility_pin' or 'utility_line',
 *     and must be null/absent otherwise;
 *   - points is required iff kind is 'utility_line' (2..200 vertices), and
 *     must be null/absent otherwise.
 */
export function validateAnnotationKindFields(data: AnnotationKindInput, ctx: z.RefinementCtx): void {
  if (isUtilityKind(data.kind)) {
    if (data.utilityType == null) {
      ctx.addIssue({
        code: "custom",
        path: ["utilityType"],
        message: "utilityType is required for utility annotations",
      });
    }
  } else if (data.utilityType != null) {
    ctx.addIssue({
      code: "custom",
      path: ["utilityType"],
      message: "utilityType must be null unless kind is a utility kind",
    });
  }

  if (data.kind === "utility_line") {
    if (data.points == null) {
      ctx.addIssue({
        code: "custom",
        path: ["points"],
        message: "points is required when kind is 'utility_line'",
      });
    }
  } else if (data.points != null) {
    ctx.addIssue({
      code: "custom",
      path: ["points"],
      message: "points must be null unless kind is 'utility_line'",
    });
  }

  // Presentation fields are optional on a line (null = type default) but
  // meaningless on anything else.
  if (data.kind !== "utility_line") {
    for (const field of ["lineStyle", "lineWeight", "flowArrows"] as const) {
      if (data[field] != null) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must be null unless kind is 'utility_line'`,
        });
      }
    }
  }
}
