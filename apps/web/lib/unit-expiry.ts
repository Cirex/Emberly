/**
 * Expiry rules for anything pinned to a unit.
 *
 * Tags established the vocabulary — never / date / duration / move_out /
 * status_change — and guest-pass suspensions now use the same one, so a guard
 * who understands "this tag lifts at move-out" understands the suspension too.
 * The engine lives here rather than in unit-tags.ts because it is about a rule
 * attached to a unit, not about tags: date and duration resolve to a concrete
 * expires_at, while move_out and status_change are evaluated against the live
 * resman_units row on every read.
 */
import type { UntypedSupabase } from "@/lib/supabase/types";

export type ExpiryKind = "never" | "date" | "duration" | "move_out" | "status_change";

/** The four columns any expiring, unit-pinned row carries. */
export interface ExpiryRule {
  expiryKind: ExpiryKind;
  expiresAt: string | null;
  boundLeaseId: string | null;
  statusTrigger: string | null;
}

/** Live context of a unit, used to resolve conditional expiry rules. */
export interface UnitContext {
  currentLeaseId: string | null;
  leaseStatus: string | null;
  occupancyStatus: string | null;
}

export async function unitContextsByNumber(
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

/** Fetch one unit's context — used when creating a rule, to snapshot it. */
export async function unitContext(
  client: UntypedSupabase,
  unitNumber: string,
): Promise<UnitContext | undefined> {
  return (await unitContextsByNumber(client, [unitNumber])).get(unitNumber);
}

/**
 * True when a conditional rule has come due given its unit's live state.
 * - move_out: the lease it rode with is gone (unit re-leased) or the unit is
 *   vacant. A missing unit row also counts as gone.
 * - status_change: the lease has left the status the rule was watching.
 */
export function conditionalRuleExpired(rule: ExpiryRule, ctx: UnitContext | undefined): boolean {
  if (rule.expiryKind === "move_out") {
    if (!ctx) return true;
    if (ctx.occupancyStatus === "Vacant") return true;
    if (rule.boundLeaseId && ctx.currentLeaseId && rule.boundLeaseId !== ctx.currentLeaseId) return true;
    return false;
  }
  if (rule.expiryKind === "status_change") {
    if (!rule.statusTrigger) return false;
    // Kept alive only while the lease status still matches the trigger.
    return (ctx?.leaseStatus ?? null) !== rule.statusTrigger;
  }
  return false;
}

/**
 * Whether a rule has come due, time-based or conditional. Enforcement paths use
 * this to ignore a stale row even before the purge sweeps it, so a suspension
 * can never outlive its rule by however long it takes the next read to land.
 */
export function ruleExpired(
  rule: ExpiryRule,
  ctx: UnitContext | undefined,
  now: number = Date.now(),
): boolean {
  if (rule.expiresAt && new Date(rule.expiresAt).getTime() < now) return true;
  return conditionalRuleExpired(rule, ctx);
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

export function readRule(row: Record<string, unknown>): ExpiryRule {
  return {
    expiryKind: (row.expiry_kind as ExpiryKind) ?? "never",
    expiresAt: (row.expires_at as string) ?? null,
    boundLeaseId: (row.bound_lease_id as string) ?? null,
    statusTrigger: (row.status_trigger as string) ?? null,
  };
}

const RULE_COLUMNS = "expiry_kind, expires_at, bound_lease_id, status_trigger";

/**
 * Delete every row in `table` whose rule has come due. Cheap and idempotent —
 * safe to call on each read, which is how both tags and suspensions stay tidy
 * without a scheduled job. Returns the number removed.
 */
export async function purgeExpiredUnitRows(
  client: UntypedSupabase,
  table: string,
  opts: { idColumn: string; unitNumberColumn?: string },
): Promise<number> {
  const idColumn = opts.idColumn;
  const unitColumn = opts.unitNumberColumn ?? "unit_number";
  const nowIso = new Date().toISOString();
  const expiredIds: unknown[] = [];

  // 1) Time-based (date/duration) — a single indexed query.
  const { data: timed } = await client
    .from(table)
    .select(idColumn)
    .not("expires_at", "is", null)
    .lt("expires_at", nowIso);
  for (const row of (timed ?? []) as Array<Record<string, unknown>>) expiredIds.push(row[idColumn]);

  // 2) Conditional (move_out/status_change) — evaluate against live unit state.
  const { data: conditional } = await client
    .from(table)
    .select(`${idColumn}, ${unitColumn}, ${RULE_COLUMNS}`)
    .in("expiry_kind", ["move_out", "status_change"]);
  const rows = (conditional ?? []) as Array<Record<string, unknown>>;
  if (rows.length > 0) {
    const numbers = [...new Set(rows.map((r) => String(r[unitColumn] ?? "").trim()).filter(Boolean))];
    const ctxByNumber = await unitContextsByNumber(client, numbers);
    for (const row of rows) {
      const ctx = ctxByNumber.get(String(row[unitColumn] ?? "").trim());
      if (conditionalRuleExpired(readRule(row), ctx)) expiredIds.push(row[idColumn]);
    }
  }

  if (expiredIds.length === 0) return 0;
  const unique = [...new Set(expiredIds)];
  await client.from(table).delete().in(idColumn, unique);
  return unique.length;
}
