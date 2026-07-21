import { listLayeredAnnotations, serializeLayeredAnnotation } from "@/lib/map-annotation-service";
import { photoIdsByAnnotation } from "@/lib/map-annotation-photos";
import { CAMERA_SELECT, serializeCamera } from "@/lib/map-cameras";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UntypedSupabase } from "@/lib/supabase/types";
import { PropertyMapClient, type AdminAnnotation, type AdminCamera } from "./property-map-client";

export const dynamic = "force-dynamic";

/**
 * The property map with its two annotation overlays: the security layer
 * (shared live with the guard iPads) and the staff layer (shared with the
 * external map client). Same drawn map as the security app — one canvas,
 * three windows onto it.
 */
export default async function PropertyMapPage() {
  const supabase = createAdminClient() as unknown as UntypedSupabase;
  const [rows, camerasResult, photoIds] = await Promise.all([
    listLayeredAnnotations(supabase, ["staff", "security", "utility"], null),
    supabase.from("map_cameras").select(CAMERA_SELECT).order("created_at", { ascending: true }),
    photoIdsByAnnotation(),
  ]);
  if (camerasResult.error) throw camerasResult.error;
  const annotations = rows.map((row) => ({
    ...serializeLayeredAnnotation(row),
    photoIds: photoIds[row.id] ?? [],
  })) as AdminAnnotation[];
  const cameras = (camerasResult.data ?? []).map(serializeCamera) as AdminCamera[];

  return <PropertyMapClient initialAnnotations={annotations} initialCameras={cameras} />;
}
