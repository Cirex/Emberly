/**
 * Shared, expiring unit tags (admins + guard iPads read/write). Serialization
 * plus the expiration engine: date/duration tags carry a concrete expires_at;
 * move_out / status_change tags are evaluated against the live resman_units row
 * and purged on every read/sync.
 */
import type { UntypedSupabase } from "@/lib/supabase/types";

export const TAG_SELECT =
  "id, unit_number, label, color_hex, expiry_kind, expires_at, bound_lease_id, status_trigger, origin, created_by_display_name, created_at";

export type ExpiryKind = "never" | "date" | "duration" | "move_out" | "status_change";

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

/** Live context of a unit, used to resolve conditional expiry rules. */
interface UnitContext {
  currentLeaseId: string | null;
  leaseStatus: string | null;
  occupancyStatus: string | null;
}

async function unitContextByNumber(
  client: UntypedSupabase,
  numbers: string[],
): Promise<Map<string, UnitContext>> {
  const map = new Map<string, UnitContext>();
  if (numbers.length === 0) return map;
  const { data } = await client
    .from("resman_units")
    .select("number, current_lease_id, lease_status, occupancy_status")
    .in("number", numbers);
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    map.set(row.number as string, {
      currentLeaseId: (row.current_lease_id as string) ?? null,
      leaseStatus: (row.lease_status as string) ?? null,
      occupancyStatus: (row.occupancy_status as string) ?? null,
    });
  }
  return map;
}

/**
 * True when a conditional tag should be removed given its unit's live state.
 * - move_out: the lease it rode with is gone (unit re-leased) or the unit is
 *   vacant. A missing unit row also counts as gone.
 * - status_change: the lease has left the status the tag was watching.
 */
function conditionalTagExpired(tag: SerializedTag, ctx: UnitContext | undefined): boolean {
  if (tag.expiryKind === "move_out") {
    if (!ctx) return true;
    if (ctx.occupancyStatus === "Vacant") return true;
    if (tag.boundLeaseId && ctx.currentLeaseId && tag.boundLeaseId !== ctx.currentLeaseId) return true;
    return false;
  }
  if (tag.expiryKind === "status_change") {
    if (!tag.statusTrigger) return false;
    // Kept alive only while the lease status still matches the trigger.
    return (ctx?.leaseStatus ?? null) !== tag.statusTrigger;
  }
  return false;
}

/**
 * Delete every tag whose rule has come due. Cheap and idempotent — safe to call
 * on each read. Returns the number of tags removed.
 */
export async function purgeExpiredTags(client: UntypedSupabase): Promise<number> {
  const nowIso = new Date().toISOString();
  const expiredIds: string[] = [];

  // 1) Time-based (date/duration) — a single indexed query.
  const { data: timed } = await client
    .from("unit_tags")
    .select("id")
    .not("expires_at", "is", null)
    .lt("expires_at", nowIso);
  for (const row of (timed ?? []) as Array<{ id: string }>) expiredIds.push(row.id);

  // 2) Conditional (move_out/status_change) — evaluate against live unit state.
  const { data: conditional } = await client
    .from("unit_tags")
    .select(TAG_SELECT)
    .in("expiry_kind", ["move_out", "status_change"]);
  const condTags = ((conditional ?? []) as Array<Record<string, unknown>>).map(serializeTag);
  if (condTags.length > 0) {
    const ctxByNumber = await unitContextByNumber(client, [
      ...new Set(condTags.map((t) => t.unitNumber)),
    ]);
    for (const tag of condTags) {
      if (conditionalTagExpired(tag, ctxByNumber.get(tag.unitNumber))) expiredIds.push(tag.id);
    }
  }

  if (expiredIds.length === 0) return 0;
  const unique = [...new Set(expiredIds)];
  await client.from("unit_tags").delete().in("id", unique);
  return unique.length;
}

export interface ExpiryInput {
  kind: ExpiryKind;
  /** ISO date (end-of-day) for 'date'. */
  expiresOn?: string | null;
  /** Days from now for 'duration'. */
  durationDays?: number | null;
}

/**
 * Resolve an editor's expiry choice into stored columns, given the unit's live
 * context (needed to snapshot the lease id / status for conditional rules).
 * Throws when a conditional rule is chosen for a unit that has no active lease.
 */
export function resolveExpiry(
  input: ExpiryInput,
  ctx: UnitContext | undefined,
): { expires_at: string | null; bound_lease_id: string | null; status_trigger: string | null } {
  const empty = { expires_at: null, bound_lease_id: null, status_trigger: null };
  switch (input.kind) {
    case "never":
      return empty;
    case "date": {
      if (!input.expiresOn) throw new Error("expiresOn required for 'date'");
      // Interpret as end of the given day (local-agnostic: 23:59:59 UTC).
      const d = new Date(`${input.expiresOn}T23:59:59.000Z`);
      if (Number.isNaN(d.getTime())) throw new Error("invalid expiresOn");
      return { ...empty, expires_at: d.toISOString() };
    }
    case "duration": {
      const days = Number(input.durationDays);
      if (!Number.isFinite(days) || days <= 0) throw new Error("durationDays must be > 0");
      const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      return { ...empty, expires_at: d.toISOString() };
    }
    case "move_out": {
      if (!ctx?.currentLeaseId) throw new Error("unit has no active lease to bind to");
      return { ...empty, bound_lease_id: ctx.currentLeaseId };
    }
    case "status_change": {
      if (!ctx?.leaseStatus) throw new Error("unit has no lease status to watch");
      return { ...empty, status_trigger: ctx.leaseStatus };
    }
    default:
      return empty;
  }
}

/** Fetch one unit's context — used by the create route to snapshot rules. */
export async function unitContext(
  client: UntypedSupabase,
  unitNumber: string,
): Promise<UnitContext | undefined> {
  return (await unitContextByNumber(client, [unitNumber])).get(unitNumber);
}
