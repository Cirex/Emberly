/**
 * Layered map annotations for first-party callers (admin portal + scanner
 * iPads). The external XCMS sync client keeps its own routes and builders in
 * lib/map-annotations.ts — pinned to the 'staff' layer — while this module
 * serves the other two doors with the same semantics: optimistic versioning
 * (expectedVersion → 409-style conflict), soft delete, `since` tombstones,
 * and an audit row per mutation.
 */
import type { Database, Json } from "../types/database";
import {
  isUtilityKind,
  type AnnotationKind,
  type LineStyle,
  type LineWeight,
  type UtilityPoint,
  type UtilityType,
} from "./map-annotation-kinds";
import { buildAnnotationResponse, type AnnotationRow } from "./map-annotations";
import { MAP_ANNOTATIONS_FEATURE_KEY } from "./map-sync";
import type { UntypedSupabase } from "./supabase/types";

export type MapAnnotationLayer = "staff" | "security" | "utility";

/**
 * The one property this deployment manages, in the same coordinates the
 * external sync client would present: ResMan account 1659 (Multi-South) and
 * the mirror's property id. Using identical scope keys keeps all three
 * writers on one canvas instead of partitioning the table by accident.
 */
export const MAP_SCOPE = {
  resmanAccountId: "1659",
  propertyId: "489f05ba-6bd4-4888-9460-88923577a6eb",
} as const;

/** Who is writing: an admin session or a scanner device. */
export interface AnnotationActor {
  origin: "admin" | "scanner";
  /** admin_users id, or "scanner:<id>" for devices. */
  actorId: string;
  displayName: string;
}

/** requireAdminOrScanner represents scanners as "scanner:<id>" admins. */
export function actorFor(admin: { adminId: string; displayName: string }): AnnotationActor {
  const scanner = admin.adminId.startsWith("scanner:");
  return {
    origin: scanner ? "scanner" : "admin",
    actorId: admin.adminId,
    displayName: admin.displayName,
  };
}

/**
 * The layers a caller may touch — scanners live on the security layer. The
 * shared 'utility' layer (pins + drawn sewer/water/gas runs) is visible to
 * both the staff and security surfaces.
 */
export function layersFor(admin: { adminId: string }): MapAnnotationLayer[] {
  return admin.adminId.startsWith("scanner:")
    ? ["security", "utility"]
    : ["staff", "security", "utility"];
}

export interface LayeredAnnotationInput {
  title: string;
  notes?: string;
  normalizedX: number;
  normalizedY: number;
  colorHex: string;
  /** Ionicons name shown on the pin; the app curates the set. */
  icon?: string;
  /** 'pin' (default), 'utility_pin', or 'utility_line'. */
  kind?: AnnotationKind;
  utilityType?: UtilityType | null;
  points?: UtilityPoint[] | null;
  /** Per-run presentation, utility_line only; null = type default. */
  lineStyle?: LineStyle | null;
  lineWeight?: LineWeight | null;
  flowArrows?: boolean | null;
}

type LayeredRow = AnnotationRow & { layer: string; origin: string; icon: string };

const SELECT =
  "id, title, notes, normalized_x, normalized_y, color_hex, kind, utility_type, points, line_style, line_weight, flow_arrows, icon, layer, origin, created_by_display_name, created_at, updated_at, deleted_at, version";

export function serializeLayeredAnnotation(row: LayeredRow) {
  return { ...buildAnnotationResponse(row), layer: row.layer, origin: row.origin, icon: row.icon };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function scoped(query: ReturnType<UntypedSupabase["from"]>["select"] extends never ? never : any) {
  return query
    .eq("resman_account_id", MAP_SCOPE.resmanAccountId)
    .eq("property_id", MAP_SCOPE.propertyId)
    .eq("feature_key", MAP_ANNOTATIONS_FEATURE_KEY);
}

export async function listLayeredAnnotations(
  client: UntypedSupabase,
  layers: MapAnnotationLayer[],
  since: string | null,
): Promise<LayeredRow[]> {
  let query = scoped(client.from("map_annotations").select(SELECT)).in("layer", layers);
  // Same contract as the sync client's GET: a full fetch omits tombstones, an
  // incremental `since` fetch includes them so deletions propagate.
  if (since) query = query.gte("updated_at", since);
  else query = query.is("deleted_at", null);
  const { data, error } = await query.order("updated_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as LayeredRow[];
}

export type MutationResult =
  | { ok: true; row: LayeredRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "version_conflict"; currentVersion: number };

export async function createLayeredAnnotation(
  client: UntypedSupabase,
  layer: MapAnnotationLayer,
  actor: AnnotationActor,
  input: LayeredAnnotationInput,
): Promise<LayeredRow> {
  const now = new Date().toISOString();
  const kind = input.kind ?? "pin";
  const insert: Database["public"]["Tables"]["map_annotations"]["Insert"] = {
    resman_account_id: MAP_SCOPE.resmanAccountId,
    property_id: MAP_SCOPE.propertyId,
    feature_key: MAP_ANNOTATIONS_FEATURE_KEY,
    // Utility kinds always land on the shared 'utility' layer, whatever layer
    // the caller asked for.
    layer: isUtilityKind(kind) ? "utility" : layer,
    origin: actor.origin,
    title: input.title.trim(),
    notes: input.notes?.trim() ?? "",
    normalized_x: clamp01(input.normalizedX),
    normalized_y: clamp01(input.normalizedY),
    color_hex: input.colorHex.trim(),
    kind,
    utility_type: input.utilityType ?? null,
    points: (input.points ?? null) as Json,
    line_style: input.lineStyle ?? null,
    line_weight: input.lineWeight ?? null,
    flow_arrows: input.flowArrows ?? null,
    icon: input.icon?.trim() || "document-text",
    created_by_key_id: null,
    created_by_display_name: actor.displayName,
    created_at: now,
    updated_by_display_name: actor.displayName,
    updated_at: now,
    version: 1,
  };
  const { data, error } = await client.from("map_annotations").insert(insert).select(SELECT).single();
  if (error || !data) throw error ?? new Error("insert returned nothing");
  await audit(client, "annotation.create", actor, (data as LayeredRow).id, {
    layer: (data as LayeredRow).layer,
  });
  return data as LayeredRow;
}

async function loadForMutation(
  client: UntypedSupabase,
  id: string,
  layers: MapAnnotationLayer[],
): Promise<LayeredRow | null> {
  const { data, error } = await scoped(client.from("map_annotations").select(SELECT))
    .eq("id", id)
    .in("layer", layers)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  return (data as LayeredRow) ?? null;
}

export async function updateLayeredAnnotation(
  client: UntypedSupabase,
  id: string,
  layers: MapAnnotationLayer[],
  actor: AnnotationActor,
  input: LayeredAnnotationInput,
  expectedVersion: number,
): Promise<MutationResult> {
  const current = await loadForMutation(client, id, layers);
  if (!current) return { ok: false, reason: "not_found" };
  if (current.version !== expectedVersion) {
    return { ok: false, reason: "version_conflict", currentVersion: current.version };
  }

  const now = new Date().toISOString();
  const kind = input.kind ?? "pin";
  const { data, error } = await scoped(
    client
      .from("map_annotations")
      .update({
        title: input.title.trim(),
        notes: input.notes?.trim() ?? "",
        normalized_x: clamp01(input.normalizedX),
        normalized_y: clamp01(input.normalizedY),
        color_hex: input.colorHex.trim(),
        kind,
        utility_type: input.utilityType ?? null,
        points: (input.points ?? null) as Json,
        line_style: input.lineStyle ?? null,
        line_weight: input.lineWeight ?? null,
        flow_arrows: input.flowArrows ?? null,
        // A row updated to a utility kind must sit on the shared 'utility'
        // layer; plain-pin updates leave the layer untouched.
        ...(isUtilityKind(kind) ? { layer: "utility" } : {}),
        ...(input.icon !== undefined ? { icon: input.icon.trim() || "document-text" } : {}),
        updated_by_display_name: actor.displayName,
        updated_at: now,
        version: expectedVersion + 1,
      }),
  )
    .eq("id", id)
    .eq("version", expectedVersion)
    .is("deleted_at", null)
    .select(SELECT)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, reason: "version_conflict", currentVersion: current.version };
  await audit(client, "annotation.update", actor, id, { layer: current.layer });
  return { ok: true, row: data as LayeredRow };
}

export async function deleteLayeredAnnotation(
  client: UntypedSupabase,
  id: string,
  layers: MapAnnotationLayer[],
  actor: AnnotationActor,
  expectedVersion: number,
): Promise<MutationResult> {
  const current = await loadForMutation(client, id, layers);
  if (!current) return { ok: false, reason: "not_found" };
  if (current.version !== expectedVersion) {
    return { ok: false, reason: "version_conflict", currentVersion: current.version };
  }

  const now = new Date().toISOString();
  const { data, error } = await scoped(
    client
      .from("map_annotations")
      .update({
        deleted_by_display_name: actor.displayName,
        deleted_at: now,
        updated_by_display_name: actor.displayName,
        updated_at: now,
        version: expectedVersion + 1,
      }),
  )
    .eq("id", id)
    .eq("version", expectedVersion)
    .is("deleted_at", null)
    .select(SELECT)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, reason: "version_conflict", currentVersion: current.version };
  await audit(client, "annotation.delete", actor, id, { layer: current.layer });
  return { ok: true, row: data as LayeredRow };
}

async function audit(
  client: UntypedSupabase,
  action: "annotation.create" | "annotation.update" | "annotation.delete",
  actor: AnnotationActor,
  annotationId: string,
  metadata: Record<string, unknown>,
) {
  const { error } = await client.from("map_annotation_audit_logs").insert({
    resman_account_id: MAP_SCOPE.resmanAccountId,
    property_id: MAP_SCOPE.propertyId,
    feature_key: MAP_ANNOTATIONS_FEATURE_KEY,
    action,
    annotation_id: annotationId,
    sync_key_id: null,
    actor_display_name: actor.displayName,
    admin_user_id: actor.actorId,
    admin_display_name: actor.displayName,
    metadata: { ...metadata, origin: actor.origin } as Json,
  });
  // Audit failures are logged, not thrown — the mutation itself succeeded.
  if (error) console.error("[map-annotation-service] audit insert failed:", error, { annotationId, action });
}
