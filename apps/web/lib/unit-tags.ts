/**
 * Shared, expiring unit tags (admins + guard iPads read/write). Serialization
 * plus the tag-specific glue; the expiration engine itself lives in
 * lib/unit-expiry.ts, because guest-pass suspensions expire by the same rules
 * and the two must not drift apart.
 */
import type { UntypedSupabase } from "@/lib/supabase/types";
import {
  type ExpiryKind,
  purgeExpiredUnitRows,
  resolveExpiry,
  unitContext,
} from "@/lib/unit-expiry";

export const TAG_SELECT =
  "id, unit_number, label, color_hex, expiry_kind, expires_at, bound_lease_id, status_trigger, origin, created_by_display_name, created_at";

// Re-exported so existing tag callers keep importing from one place.
export type { ExpiryKind, ExpiryInput, UnitContext } from "@/lib/unit-expiry";
export { resolveExpiry, unitContext };

export interface SerializedTag {
  id: string;
  unitNumber: string;
  label: string;
  colorHex: string;
  expiryKind: ExpiryKind;
  expiresAt: string | null;
  boundLeaseId: string | null;
  statusTrigger: string | null;
  origin: string;
  createdByDisplayName: string | null;
  createdAt: string | null;
}

export function serializeTag(row: Record<string, unknown>): SerializedTag {
  return {
    id: row.id as string,
    unitNumber: (row.unit_number as string) ?? "",
    label: (row.label as string) ?? "",
    colorHex: (row.color_hex as string) ?? "#5B7C99",
    expiryKind: (row.expiry_kind as ExpiryKind) ?? "never",
    expiresAt: (row.expires_at as string) ?? null,
    boundLeaseId: (row.bound_lease_id as string) ?? null,
    statusTrigger: (row.status_trigger as string) ?? null,
    origin: (row.origin as string) ?? "admin",
    createdByDisplayName: (row.created_by_display_name as string) ?? null,
    createdAt: (row.created_at as string) ?? null,
  };
}

/**
 * Delete every tag whose rule has come due. Cheap and idempotent — safe to call
 * on each read. Returns the number of tags removed.
 */
export async function purgeExpiredTags(client: UntypedSupabase): Promise<number> {
  return purgeExpiredUnitRows(client, "unit_tags", { idColumn: "id" });
}
