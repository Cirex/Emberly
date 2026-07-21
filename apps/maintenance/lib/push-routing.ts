import { z } from "zod";

/**
 * Pure mapping from an incoming push payload to the work order it points at.
 * Emergency pushes carry `data: { workOrderId, unitNumber }`; anything else —
 * malformed payloads, other notification types — resolves to null and the tap
 * just opens the app.
 */

const EmergencyPushData = z.object({
  // The server sends a string id; numbers are tolerated and normalized so a
  // future serializer change can't silently break tap-to-open.
  workOrderId: z.union([z.string().min(1), z.number()]),
});

/** The work-order id an emergency push points at, or null when it isn't one. */
export function emergencyWorkOrderIdFrom(data: unknown): string | null {
  const parsed = EmergencyPushData.safeParse(data);
  if (!parsed.success) return null;
  return String(parsed.data.workOrderId);
}
