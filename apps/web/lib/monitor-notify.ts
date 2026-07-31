/**
 * Tell someone when the monitor finds something.
 *
 * The monitor writes findings to a table. A table nobody opens is not an alert,
 * so this is the last step that makes the rest of it matter: a push to the
 * manager fleet when something NEW and serious appears.
 *
 * Three rules shape everything here.
 *
 * 1. NEW findings only. A finding that has already been notified is not
 *    re-sent, however many nights it persists — `notified_at` on the row is the
 *    record. Re-alerting nightly is how people turn alerts off.
 * 2. ONE digest, not one push per finding. Fourteen criticals in a run is one
 *    notification, because fourteen is a notification storm and gets the app
 *    muted.
 * 3. NO detail in the body. An anomaly summary carries a service address, which
 *    identifies a resident, and a push body renders on a locked screen in
 *    public. The notification says how many and how bad; the app shows what.
 */

import { sendExpoPushMessages, type ExpoPushMessage } from "@emberly/core";
import type { Finding } from "./monitor";
import type { UntypedSupabase } from "./supabase/types";

/** The alert-kind key manager devices opt in/out of for these. */
export const MONITOR_ALERT_KIND = "monitor";

/** Severities worth waking someone for. `warn` accumulates in the table. */
const NOTIFY_SEVERITIES = new Set(["critical"]);

export interface NotifyResult {
  considered: number;
  notified: number;
  sent: number;
  failed: number;
  skipped: string;
}

interface PushTokenRow {
  expo_push_token: string;
  alert_kinds: string[] | null;
}

/**
 * Body text for a digest. Deliberately contentless: counts and severity only.
 *
 * "3 new critical findings" is enough to make someone open the app, and it is
 * the most that can be said on a lock screen without leaking which unit.
 */
export function buildDigestBody(findings: readonly Finding[]): { title: string; body: string } {
  const anomalies = findings.filter((f) => f.kind === "anomaly").length;
  const staleness = findings.filter((f) => f.kind === "staleness").length;
  const parts: string[] = [];
  if (anomalies > 0) parts.push(`${anomalies} anomal${anomalies === 1 ? "y" : "ies"}`);
  if (staleness > 0) parts.push(`${staleness} stale data source${staleness === 1 ? "" : "s"}`);
  return {
    title: findings.length === 1 ? "New critical finding" : `${findings.length} new critical findings`,
    body: `${parts.join(", ")}. Open Emberly to review.`,
  };
}

/** One message per registered device, all carrying the same digest. */
export function buildMonitorPushMessages(
  tokens: readonly PushTokenRow[],
  findings: readonly Finding[],
): ExpoPushMessage[] {
  const { title, body } = buildDigestBody(findings);
  return tokens
    // An empty/absent alert_kinds means "no recorded preference", which the
    // rest of the fleet treats as all kinds — matching push-tokens.ts.
    .filter((t) => !t.alert_kinds || t.alert_kinds.length === 0 || t.alert_kinds.includes(MONITOR_ALERT_KIND))
    .map((t) => ({
      to: t.expo_push_token,
      title,
      body,
      sound: "default" as const,
      priority: "high" as const,
      // Deep-link target only. No summary, no entity, no address — the payload
      // is readable by anything that can read the notification.
      data: { route: "/monitor", kind: MONITOR_ALERT_KIND, count: findings.length },
    }));
}

/**
 * Notify the manager fleet about findings that have not been notified before.
 *
 * Best-effort throughout: a push failure must never fail the monitor run that
 * produced the findings. Marks `notified_at` only for what was actually
 * dispatched, so a failed send is retried on the next run rather than silently
 * swallowed.
 */
export async function notifyMonitorFindings(
  client: UntypedSupabase,
  findings: readonly Finding[],
  deps: { log?: (message: string) => void } = {},
): Promise<NotifyResult> {
  const log = deps.log ?? (() => {});
  const candidates = findings.filter((f) => NOTIFY_SEVERITIES.has(f.severity));
  const base: NotifyResult = { considered: candidates.length, notified: 0, sent: 0, failed: 0, skipped: "" };
  if (candidates.length === 0) return { ...base, skipped: "nothing critical" };

  // Already-notified findings are excluded here, not at the send: a finding
  // that persists for a week must alert once, on the night it appeared.
  const fingerprints = candidates.map((f) => f.fingerprint);
  const { data: known, error: knownError } = await client
    .from("monitor_findings")
    .select("fingerprint, notified_at")
    .in("fingerprint", fingerprints);
  if (knownError) {
    log(`[monitor-notify] could not read notified state: ${knownError.message}`);
    return { ...base, skipped: "notified-state read failed" };
  }
  const notifiedAlready = new Set(
    ((known ?? []) as { fingerprint: string; notified_at: string | null }[])
      .filter((r) => r.notified_at !== null)
      .map((r) => r.fingerprint),
  );
  const fresh = candidates.filter((f) => !notifiedAlready.has(f.fingerprint));
  if (fresh.length === 0) return { ...base, skipped: "all already notified" };

  const { data: tokenRows, error: tokenError } = await client
    .from("push_tokens")
    .select("expo_push_token, alert_kinds")
    .eq("app", "manager")
    .eq("active", true);
  if (tokenError) {
    log(`[monitor-notify] could not read push tokens: ${tokenError.message}`);
    return { ...base, notified: fresh.length, skipped: "token read failed" };
  }

  const messages = buildMonitorPushMessages((tokenRows ?? []) as PushTokenRow[], fresh);
  if (messages.length === 0) {
    // No device to tell. The findings are still marked notified: they are in
    // the table, and holding them back would fire a stale digest the first time
    // someone registers a device weeks later.
    await client
      .from("monitor_findings")
      .update({ notified_at: new Date().toISOString() })
      .in("fingerprint", fresh.map((f) => f.fingerprint));
    return { ...base, notified: fresh.length, skipped: "no registered manager devices" };
  }

  const result = await sendExpoPushMessages(messages, { log });

  // Tokens Expo rejected as unregistered are dead devices, not transient
  // failures — deactivate them so the next run does not retry them.
  if (result.invalidTokens.length > 0) {
    await client
      .from("push_tokens")
      .update({ active: false })
      .in("expo_push_token", result.invalidTokens);
    log(`[monitor-notify] deactivated ${result.invalidTokens.length} unregistered token(s)`);
  }

  // Only mark notified if something actually got through; otherwise the next
  // run retries rather than the finding being silently dropped.
  if (result.sent > 0) {
    await client
      .from("monitor_findings")
      .update({ notified_at: new Date().toISOString() })
      .in("fingerprint", fresh.map((f) => f.fingerprint));
  }

  return {
    considered: candidates.length,
    notified: result.sent > 0 ? fresh.length : 0,
    sent: result.sent,
    failed: result.failed,
    skipped: "",
  };
}
