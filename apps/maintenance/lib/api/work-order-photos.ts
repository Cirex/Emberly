import { z } from "zod";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * Device-side client for completion photos on ResMan work orders. Same wire
 * format as the map-annotation photo upload (base64 JSON), same Bearer auth as
 * the close/work-order calls. The server stores bytes in Emberly; ResMan
 * write-back is deferred alongside the close stub.
 */

/** Machine values, never translated (AGENTS.md · Localization). */
export const WORK_ORDER_PHOTO_PHASES = ["before", "after", "completion"] as const;
export type WorkOrderPhotoPhase = (typeof WORK_ORDER_PHOTO_PHASES)[number];

/** Injectable for tests — the app always passes the global fetch. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const BASE = "/api/resman/work-orders";

function headers(config: StaffConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.token}`,
    "Content-Type": "application/json",
  };
}

const UploadResponseSchema = z.object({
  data: z.object({ id: z.string() }),
});

export type WorkOrderPhotoUploadOutcome =
  | { ok: true; serverId: string }
  /** retry: transient (offline-ish server state, 404 mirror lag, 429/5xx). */
  | { ok: false; retry: boolean; status: number };

/**
 * Statuses worth another sync tick: 404 (the mirror may not have absorbed the
 * work order yet), 408/429 (throttling), and 5xx (server trouble). Everything
 * else — bad payload, auth — won't improve by repeating the same request.
 */
function isRetryableStatus(status: number): boolean {
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

/**
 * POST one photo. Network failures throw (the caller's queue holds the entry);
 * HTTP failures return an outcome so the queue can decide retry vs drop.
 */
export async function uploadWorkOrderPhoto(
  workOrderId: string,
  dataBase64: string,
  phase: WorkOrderPhotoPhase,
  config: StaffConfig,
  fetchImpl: FetchLike = fetch,
): Promise<WorkOrderPhotoUploadOutcome> {
  const res = await fetchImpl(
    `${config.baseUrl}${BASE}/${encodeURIComponent(workOrderId)}/photos`,
    {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({ dataBase64, contentType: "image/jpeg", phase }),
    },
  );
  if (res.ok) {
    return { ok: true, serverId: UploadResponseSchema.parse(await res.json()).data.id };
  }
  return { ok: false, retry: isRetryableStatus(res.status), status: res.status };
}

export const WorkOrderPhotoMetaSchema = z.object({
  id: z.string(),
  // String-tolerant like the work-order enums: a widened phase set upstream
  // must degrade gracefully, never throw.
  phase: z.string(),
  contentType: z.string(),
  byteSize: z.number(),
  createdBy: z.string(),
  createdAt: z.string().nullable(),
});
export type WorkOrderPhotoMeta = z.infer<typeof WorkOrderPhotoMetaSchema>;

const ListResponseSchema = z.object({ data: z.array(WorkOrderPhotoMetaSchema) });

/** GET the work order's live photos, newest first. */
export async function listWorkOrderPhotos(
  workOrderId: string,
  config: StaffConfig,
  fetchImpl: FetchLike = fetch,
): Promise<WorkOrderPhotoMeta[]> {
  const res = await fetchImpl(
    `${config.baseUrl}${BASE}/${encodeURIComponent(workOrderId)}/photos`,
    { headers: { Authorization: `Bearer ${config.token}` } },
  );
  if (res.status === 401 || res.status === 403) throw new Error("Not authorized for the ResMan API");
  if (!res.ok) throw new Error(`Failed to load work order photos (${res.status})`);
  return ListResponseSchema.parse(await res.json()).data;
}
