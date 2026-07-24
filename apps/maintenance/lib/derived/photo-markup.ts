import type { WorkOrderPhotoPhase } from "@/lib/api/work-order-photos";

/**
 * Marked-up work-order photos, and the rule for retiring the originals.
 *
 * A capture is kept twice: the untouched original, and a flattened copy with
 * the tech's markup burned in. Both live on the device until the work order is
 * submitted; after that the original is expired and the marked copy stands, so
 * a phone full of before/after pairs doesn't grow without bound.
 *
 * The expiry rule is the dangerous part — it deletes a photograph of someone's
 * apartment that cannot be retaken — so it is pure, conservative, and tested.
 */

export type MarkupTool = "freehand" | "circle" | "arrow" | "note";

export interface MarkupPoint {
  x: number;
  y: number;
}

export interface MarkupStroke {
  id: string;
  tool: MarkupTool;
  color: string;
  /** Freehand: the path. Circle/arrow: start and end. Note: the anchor. */
  points: MarkupPoint[];
  /** Only for `note`. */
  text?: string;
}

export interface MarkedPhoto {
  photoId: string;
  workOrderId: string;
  phase: WorkOrderPhotoPhase;
  /** The untouched capture — null once expired. */
  originalUri: string | null;
  /** Flattened copy with markup burned in; null until the tech saves markup. */
  markedUri: string | null;
  strokes: MarkupStroke[];
  capturedAt: number;
  /** Epoch ms the original was retired, or null while it is still held. */
  originalExpiredAt: number | null;
}

/** The image to show and to upload: the marked copy when there is one. */
export function displayUri(photo: MarkedPhoto): string | null {
  return photo.markedUri ?? photo.originalUri;
}

export function hasMarkup(photo: MarkedPhoto): boolean {
  return photo.strokes.length > 0;
}

/**
 * Whether this photo's original may be retired.
 *
 * Every clause is a refusal to destroy the only copy:
 *   - the work order must actually be submitted
 *   - the original must still exist (idempotent — expiring twice is a no-op)
 *   - a marked copy must exist to stand in its place; an unmarked photo keeps
 *     its original forever, because expiring it would leave nothing at all
 */
export function canExpireOriginal(photo: MarkedPhoto, submittedWorkOrderIds: ReadonlySet<string>): boolean {
  if (!submittedWorkOrderIds.has(photo.workOrderId)) return false;
  if (photo.originalUri === null) return false;
  if (photo.markedUri === null) return false;
  return true;
}

/**
 * The originals to retire, given which work orders have been submitted.
 * Returns the photos themselves so the caller can delete the files it owns.
 */
export function expirableOriginals(
  photos: MarkedPhoto[],
  submittedWorkOrderIds: ReadonlySet<string>,
): MarkedPhoto[] {
  return photos.filter((p) => canExpireOriginal(p, submittedWorkOrderIds));
}

/** Apply the retirement to a photo record. The file deletion is the caller's. */
export function expireOriginal(photo: MarkedPhoto, nowMs: number): MarkedPhoto {
  if (photo.originalUri === null) return photo;
  return { ...photo, originalUri: null, originalExpiredAt: nowMs };
}

/** Before and after for one work order, newest last within each phase. */
export function groupByPhase(photos: MarkedPhoto[]): Record<WorkOrderPhotoPhase, MarkedPhoto[]> {
  const out: Record<WorkOrderPhotoPhase, MarkedPhoto[]> = { before: [], after: [], completion: [] };
  for (const photo of [...photos].sort((a, b) => a.capturedAt - b.capturedAt)) {
    out[photo.phase].push(photo);
  }
  return out;
}
