import { z } from "zod";
import type { StaffConfig } from "@/lib/stores/config";

type ScannerConfig = StaffConfig;

/**
 * Device-side client for the layered map annotations. The server scopes each
 * credential to its layer, so nothing here names layers — whatever this device
 * reads or writes is its own layer by construction.
 */

export const RemoteAnnotationSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string(),
  normalizedX: z.number(),
  normalizedY: z.number(),
  colorHex: z.string(),
  icon: z.string().catch("document-text"),
  createdByDisplayName: z.string().nullable(),
  updatedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  version: z.number(),
});
export type RemoteAnnotation = z.infer<typeof RemoteAnnotationSchema>;

const ListSchema = z.object({ annotations: z.array(RemoteAnnotationSchema) });
const OneSchema = z.object({ annotation: RemoteAnnotationSchema });

function headers(config: ScannerConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.token}`,
    "Content-Type": "application/json",
  };
}

const BASE = "/api/admin/map-annotations";

export async function listAnnotations(config: ScannerConfig): Promise<RemoteAnnotation[]> {
  const res = await fetch(`${config.baseUrl}${BASE}`, { headers: headers(config) });
  if (!res.ok) throw new Error(`Failed to load annotations (${res.status})`);
  return ListSchema.parse(await res.json()).annotations;
}

export interface AnnotationFields {
  title: string;
  notes: string;
  normalizedX: number;
  normalizedY: number;
  colorHex: string;
  icon: string;
}

export async function createAnnotation(
  fields: AnnotationFields,
  config: ScannerConfig,
): Promise<RemoteAnnotation> {
  const res = await fetch(`${config.baseUrl}${BASE}`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`Failed to create annotation (${res.status})`);
  return OneSchema.parse(await res.json()).annotation;
}

export type MutationOutcome =
  | { ok: true; annotation: RemoteAnnotation }
  | { ok: false; conflict: true }
  | { ok: false; conflict: false; status: number };

export async function updateAnnotation(
  id: string,
  fields: AnnotationFields,
  expectedVersion: number,
  config: ScannerConfig,
): Promise<MutationOutcome> {
  const res = await fetch(`${config.baseUrl}${BASE}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: headers(config),
    body: JSON.stringify({ ...fields, expectedVersion }),
  });
  if (res.ok) return { ok: true, annotation: OneSchema.parse(await res.json()).annotation };
  // A 404 means the pin is gone server-side (deleted elsewhere) — treat like a
  // conflict: the next pull removes it locally.
  if (res.status === 409 || res.status === 404) return { ok: false, conflict: true };
  return { ok: false, conflict: false, status: res.status };
}

export async function deleteAnnotation(
  id: string,
  expectedVersion: number,
  config: ScannerConfig,
): Promise<{ ok: boolean; conflict: boolean }> {
  const res = await fetch(`${config.baseUrl}${BASE}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: headers(config),
    body: JSON.stringify({ expectedVersion }),
  });
  if (res.ok) return { ok: true, conflict: false };
  return { ok: false, conflict: res.status === 409 || res.status === 404 };
}

/* ---------------- annotation photos ---------------- */

const PhotoSchema = z.object({ photo: z.object({ id: z.string() }) });

export type PhotoUploadOutcome =
  | { ok: true; serverId: string }
  /** The annotation isn't on the server (yet) — retry after the pin syncs. */
  | { ok: false; retry: true }
  | { ok: false; retry: false; status: number };

export async function uploadAnnotationPhoto(
  annotationId: string,
  dataBase64: string,
  config: ScannerConfig,
): Promise<PhotoUploadOutcome> {
  const res = await fetch(`${config.baseUrl}${BASE}/${encodeURIComponent(annotationId)}/photos`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ dataBase64, contentType: "image/jpeg" }),
  });
  if (res.ok) return { ok: true, serverId: PhotoSchema.parse(await res.json()).photo.id };
  if (res.status === 404) return { ok: false, retry: true };
  return { ok: false, retry: false, status: res.status };
}

export async function deleteAnnotationPhoto(
  serverPhotoId: string,
  config: ScannerConfig,
): Promise<boolean> {
  const res = await fetch(
    `${config.baseUrl}/api/admin/map-annotation-photos/${encodeURIComponent(serverPhotoId)}`,
    { method: "DELETE", headers: headers(config) },
  );
  // 404 = already gone; both ways the queue entry is settled.
  return res.ok || res.status === 404;
}
