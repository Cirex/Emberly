/**
 * Unit-level guest-pass suspensions, and the one place that decides whether a
 * suspension is still in force.
 *
 * Every enforcement path (pass creation, verify-pass at the gate, unit detail,
 * the guard app's "No Guests" list) must agree, so none of them read the table
 * directly — an expired row is still a row until the purge sweeps it, and a
 * resident should not be refused a pass by a suspension that lifted at 2am.
 */
import type { UntypedSupabase } from "@/lib/supabase/types";
import {
  type ExpiryKind,
  purgeExpiredUnitRows,
  readRule,
  ruleExpired,
  unitContextsByNumber,
} from "@/lib/unit-expiry";

export const BAN_SELECT =
  "resman_unit_id, unit_number, reason, banned_by, banned_at, expiry_kind, expires_at, bound_lease_id, status_trigger";

export interface SerializedUnitBan {
  resmanUnitId: string;
  unitNumber: string;
  reason: string | null;
  bannedBy: string;
  bannedAt: string | null;
  expiryKind: ExpiryKind;
  expiresAt: string | null;
  boundLeaseId: string | null;
  statusTrigger: string | null;
}

export function serializeUnitBan(row: Record<string, unknown>): SerializedUnitBan {
  return {
    resmanUnitId: row.resman_unit_id as string,
    unitNumber: (row.unit_number as string) ?? "",
    reason: (row.reason as string) ?? null,
    bannedBy: (row.banned_by as string) ?? "",
    bannedAt: (row.banned_at as string) ?? null,
    expiryKind: (row.expiry_kind as ExpiryKind) ?? "never",
    expiresAt: (row.expires_at as string) ?? null,
    boundLeaseId: (row.bound_lease_id as string) ?? null,
    statusTrigger: (row.status_trigger as string) ?? null,
  };
}

/** Delete suspensions whose rule has come due. Idempotent; safe on every read. */
export async function purgeExpiredUnitBans(client: UntypedSupabase): Promise<number> {
  return purgeExpiredUnitRows(client, "guest_pass_unit_bans", { idColumn: "resman_unit_id" });
}

/**
 * The suspension in force for a unit number, or null.
 *
 * Evaluates the rule rather than trusting the row's presence, so a lapsed
 * suspension stops blocking the moment it lapses — not whenever a purge next
 * runs. Used by the creation gate and by verify-pass, where being wrong means
 * either turning away a legitimate guest or admitting a banned one.
 */
export async function activeUnitBanForNumber(
  client: UntypedSupabase,
  unitNumber: string,
): Promise<SerializedUnitBan | null> {
  const trimmed = unitNumber?.trim();
  if (!trimmed) return null;

  const { data } = await client
    .from("guest_pass_unit_bans")
    .select(BAN_SELECT)
    .eq("unit_number", trimmed)
    .maybeSingle();
  if (!data) return null;

  const row = data as Record<string, unknown>;
  const rule = readRule(row);
  if (rule.expiryKind === "never" && !rule.expiresAt) return serializeUnitBan(row);

  const ctx = (await unitContextsByNumber(client, [trimmed])).get(trimmed);
  return ruleExpired(rule, ctx) ? null : serializeUnitBan(row);
}

/**
 * Same question for a ResMan unit id — the key the admin UI and the bulk
 * detail route work in.
 */
export async function activeUnitBanForId(
  client: UntypedSupabase,
  resmanUnitId: string,
): Promise<SerializedUnitBan | null> {
  const { data } = await client
    .from("guest_pass_unit_bans")
    .select(BAN_SELECT)
    .eq("resman_unit_id", resmanUnitId)
    .maybeSingle();
  if (!data) return null;

  const row = data as Record<string, unknown>;
  const ban = serializeUnitBan(row);
  const rule = readRule(row);
  if (rule.expiryKind === "never" && !rule.expiresAt) return ban;

  const ctx = (await unitContextsByNumber(client, [ban.unitNumber])).get(ban.unitNumber);
  return ruleExpired(rule, ctx) ? null : ban;
}

/**
 * Every suspension in force, keyed by resman_unit_id — for the bulk detail
 * route and the guard app's "No Guests" list, which need the whole property at
 * once and must not pay a query per unit.
 */
export async function activeUnitBans(
  client: UntypedSupabase,
  rows: Record<string, unknown>[],
): Promise<Map<string, SerializedUnitBan>> {
  const bans = rows.map(serializeUnitBan);
  const conditional = bans.filter((b) => b.expiryKind !== "never" || b.expiresAt);
  const ctxByNumber =
    conditional.length > 0
      ? await unitContextsByNumber(client, [...new Set(conditional.map((b) => b.unitNumber))])
      : new Map();

  const out = new Map<string, SerializedUnitBan>();
  const now = Date.now();
  for (const ban of bans) {
    const rule: ReturnType<typeof readRule> = {
      expiryKind: ban.expiryKind,
      expiresAt: ban.expiresAt,
      boundLeaseId: ban.boundLeaseId,
      statusTrigger: ban.statusTrigger,
    };
    if (rule.expiryKind === "never" && !rule.expiresAt) {
      out.set(ban.resmanUnitId, ban);
      continue;
    }
    if (!ruleExpired(rule, ctxByNumber.get(ban.unitNumber), now)) out.set(ban.resmanUnitId, ban);
  }
  return out;
}
