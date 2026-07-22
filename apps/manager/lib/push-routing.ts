import { z } from "zod";

/**
 * Pure mapping from an incoming manager-alert push payload to the in-app
 * destination it points at.
 *
 * The sync worker sends `data: { route, kind, id }` (supabase/sync/src/manager/
 * alerts.ts). Anything else — a malformed payload, a future alert type this
 * build doesn't know, a maintenance-app payload that somehow landed here —
 * resolves to null and the tap just opens the app on whatever tab it was on.
 *
 * The route allow-list is deliberate: a push payload is untrusted input, and
 * feeding an arbitrary string to the router would let a malformed (or spoofed)
 * notification navigate anywhere in the app.
 */

/** The alert kinds the server can send. Mirrors apps/web/lib/manager-alerts.ts. */
export const MANAGER_ALERT_KINDS = [
  "application_received",
  "lease_signed",
  "balance_threshold",
  "eviction_milestone",
  "utility_spike",
  "renewal_offer_silent",
  "policy_lapsed",
] as const;

export type ManagerAlertKind = (typeof MANAGER_ALERT_KINDS)[number];

/** Every destination an alert is allowed to open. */
export const MANAGER_ALERT_ROUTES = [
  "/(tabs)/leasing",
  "/(tabs)/delinquency",
  "/(tabs)/utilities",
] as const;

export type ManagerAlertRoute = (typeof MANAGER_ALERT_ROUTES)[number];

const ManagerPushData = z.object({
  route: z.enum(MANAGER_ALERT_ROUTES),
  // Kind and id are advisory: `kind` only feeds analytics, and `id` is the
  // source row the alert announced (unused by the tab routes today, kept so a
  // future detail screen can deep-link without a server change). Numbers are
  // tolerated and normalized so a serializer change can't break tap-to-open.
  kind: z.enum(MANAGER_ALERT_KINDS).optional(),
  id: z.union([z.string().min(1), z.number()]).nullish(),
});

export interface ManagerPushTarget {
  route: ManagerAlertRoute;
  /** null when the payload didn't name a known kind. */
  kind: ManagerAlertKind | null;
  /** null when the payload carried no source id. */
  id: string | null;
}

/** Where a manager-alert push should navigate, or null when it isn't one. */
export function managerPushTargetFrom(data: unknown): ManagerPushTarget | null {
  const parsed = ManagerPushData.safeParse(data);
  if (!parsed.success) return null;
  const { route, kind, id } = parsed.data;
  return {
    route,
    kind: kind ?? null,
    id: id === null || id === undefined ? null : String(id),
  };
}

/** Type guard for values crossing the persisted-settings boundary. */
export function isManagerAlertKind(value: unknown): value is ManagerAlertKind {
  return typeof value === "string" && (MANAGER_ALERT_KINDS as readonly string[]).includes(value);
}
