/**
 * Manager alerts sync job: read the mirror → run the pure detectors
 * (./alert-rules) → claim each alert in public.manager_alert_notifications →
 * fan it out to the registered MANAGER devices via the shared Expo sender.
 *
 * FLEET SCOPING: push_tokens.app discriminates the two staff apps. This job
 * only ever reads `app = 'manager'` rows and the emergency work-order job only
 * reads `app = 'maintenance'` rows, so neither fleet can be spammed with the
 * other's notifications. Per-device opt-outs ride in push_tokens.alert_kinds
 * (empty = all kinds), which the manager app writes at registration.
 *
 * CLAIM BEFORE SEND: the ledger row is inserted first and (kind, subject_key)
 * is unique, so an alert can fire at most once even if the process dies
 * mid-send. The trade-off is deliberate: losing a push beats double-pushing a
 * whole fleet, and the source state is still visible in the app.
 *
 * Unlike the ResMan/MLGW jobs this one scrapes nothing — it reads the already
 * synced mirror tables, so it is safe to schedule right after the sync
 * pipeline (or on its own short interval).
 */
import type { ServiceClient } from "../db/client";
import { sendExpoPushMessages, type ExpoPushMessage } from "../shared/push";
import {
  MANAGER_ALERT_KINDS,
  detectManagerAlerts,
  emptyNotifiedMap,
  tokensForAlert,
  type ManagerAlert,
  type ManagerAlertKind,
  type ManagerDevice,
} from "./alert-rules";

/** PostgREST caps an unbounded select at 1000 rows; page everything at this size. */
const PAGE = 1000;

/** How far back the source reads look. Detectors re-check freshness anyway. */
const LOOKBACK_DAYS = 45;

/** Utility history window — `typicalUtilityCharges` needs prior months. */
const UTILITY_LOOKBACK_DAYS = 400;

export interface SyncManagerAlertsParams {
  supabase: ServiceClient;
  /** Balance alert crossing point, dollars (default DEFAULT_BALANCE_THRESHOLD). */
  balanceThreshold?: number;
  /** Injected for tests/backfills; defaults to now. */
  now?: Date;
  /** Detect and claim, but never call Expo. */
  dryRun?: boolean;
  log?: (message: string) => void;
}

export interface SyncManagerAlertsResult {
  /** Alerts the detectors produced this pass. */
  detected: number;
  /** Alerts claimed in the ledger (i.e. not already claimed by a racing run). */
  claimed: number;
  /** Push messages Expo accepted. */
  sent: number;
  /** Push messages Expo rejected or that never reached it. */
  failed: number;
  /** Active manager devices the pass fanned out to. */
  devices: number;
  /** Balance ledger rows cleared because the unit fell back under the band. */
  rearmed: number;
  perKind: Record<ManagerAlertKind, number>;
}

/** "YYYY-MM-DD" `days` before `from`. */
function isoDaysBefore(from: Date, days: number): string {
  return new Date(from.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Page a select through PostgREST's 1000-row window. */
async function readAll<T>(
  supabase: ServiceClient,
  table: string,
  columns: string,
  refine: (query: any) => any = (q) => q,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await refine(supabase.from(table).select(columns)).range(
      from,
      from + PAGE - 1,
    );
    if (error) throw new Error(`read ${table} failed: ${error.message}`);
    const batch = (data ?? []) as unknown as T[];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

/** Already-claimed subject keys, grouped by kind. */
async function loadNotified(
  supabase: ServiceClient,
): Promise<Record<ManagerAlertKind, Set<string>>> {
  const rows = await readAll<{ kind: string; subject_key: string }>(
    supabase,
    "manager_alert_notifications",
    "kind, subject_key",
  );
  const notified = emptyNotifiedMap() as Record<ManagerAlertKind, Set<string>>;
  for (const kind of MANAGER_ALERT_KINDS) notified[kind] = new Set<string>();
  for (const row of rows) {
    const set = notified[row.kind as ManagerAlertKind];
    if (set) set.add(row.subject_key);
  }
  return notified;
}

/** Active manager-app devices with their per-kind opt-ins. */
export async function loadManagerDevices(supabase: ServiceClient): Promise<ManagerDevice[]> {
  const rows = await readAll<{ expo_push_token: string; alert_kinds: string[] | null }>(
    supabase,
    "push_tokens",
    "expo_push_token, alert_kinds",
    // The scoping that keeps manager alerts off maintenance phones.
    (q) => q.eq("active", true).eq("app", "manager"),
  );
  return rows
    .map((row) => ({
      expoPushToken: (row.expo_push_token ?? "").trim(),
      alertKinds: Array.isArray(row.alert_kinds) ? row.alert_kinds : [],
    }))
    .filter((device) => device.expoPushToken.length > 0);
}

/** One Expo message per (alert, subscribed device). */
export function buildManagerPushMessages(
  alert: ManagerAlert,
  devices: ReadonlyArray<ManagerDevice>,
): ExpoPushMessage[] {
  return tokensForAlert(devices, alert.kind).map((to) => ({
    to,
    title: alert.title,
    body: alert.body,
    sound: "default" as const,
    priority: "high" as const,
    data: { route: alert.data.route, kind: alert.kind, id: alert.data.id ?? null },
  }));
}

/**
 * Insert the ledger rows for `alerts`, ignoring ones another run already
 * claimed. Returns the alerts THIS run owns and may therefore send.
 */
async function claimAlerts(
  supabase: ServiceClient,
  alerts: ReadonlyArray<ManagerAlert>,
  devices: number,
  now: Date,
): Promise<ManagerAlert[]> {
  if (alerts.length === 0) return [];
  const { data, error } = await supabase
    .from("manager_alert_notifications")
    .upsert(
      alerts.map((alert) => ({
        kind: alert.kind,
        subject_key: alert.subjectKey,
        unit_number: alert.unitNumber,
        title: alert.title,
        body: alert.body,
        amount: alert.amount,
        devices,
        notified_at: now.toISOString(),
      })),
      { onConflict: "kind,subject_key", ignoreDuplicates: true },
    )
    .select("kind, subject_key");
  if (error) throw new Error(`claim manager_alert_notifications failed: ${error.message}`);
  const claimed = new Set(
    ((data ?? []) as unknown as Array<{ kind: string; subject_key: string }>).map(
      (row) => `${row.kind}|${row.subject_key}`,
    ),
  );
  return alerts.filter((alert) => claimed.has(`${alert.kind}|${alert.subjectKey}`));
}

/** Clear balance claims for units that dropped back under the re-arm band. */
async function rearmBalances(
  supabase: ServiceClient,
  unitIds: ReadonlyArray<string>,
): Promise<number> {
  if (unitIds.length === 0) return 0;
  const { error } = await supabase
    .from("manager_alert_notifications")
    .delete()
    .eq("kind", "balance_threshold")
    .in("subject_key", unitIds as string[]);
  if (error) throw new Error(`re-arm balance alerts failed: ${error.message}`);
  return unitIds.length;
}

/** Expo told us a token is dead — stop sending to it. */
async function deactivateTokens(
  supabase: ServiceClient,
  tokens: ReadonlyArray<string>,
  log: (message: string) => void,
): Promise<void> {
  if (tokens.length === 0) return;
  const { error } = await supabase
    .from("push_tokens")
    .update({ active: false })
    .in("expo_push_token", tokens as string[]);
  if (error) log(`[manager-alerts] WARNING: deactivating stale push tokens failed: ${error.message}`);
}

export async function syncManagerAlerts(
  params: SyncManagerAlertsParams,
): Promise<SyncManagerAlertsResult> {
  const { supabase } = params;
  const log = params.log ?? (() => {});
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const since = isoDaysBefore(now, LOOKBACK_DAYS);
  const utilitySince = isoDaysBefore(now, UTILITY_LOOKBACK_DAYS);

  const perKind = Object.fromEntries(MANAGER_ALERT_KINDS.map((k) => [k, 0])) as Record<
    ManagerAlertKind,
    number
  >;

  // --- read the mirror ------------------------------------------------------
  // Leases are pulled twice (applied-recently, signed-recently) and merged so
  // neither date's window is widened by the other's.
  const [applied, signed, units, actions, bills, accounts, notified] = await Promise.all([
    readAll<Record<string, unknown>>(
      supabase,
      "resman_leases",
      "resman_lease_id, unit_number, application_date, signed_date",
      (q) => q.gte("application_date", since),
    ),
    readAll<Record<string, unknown>>(
      supabase,
      "resman_leases",
      "resman_lease_id, unit_number, application_date, signed_date",
      (q) => q.gte("signed_date", since),
    ),
    readAll<Record<string, unknown>>(
      supabase,
      "resman_units",
      "resman_unit_id, number, balance",
      (q) => q.not("balance", "is", null),
    ),
    readAll<Record<string, unknown>>(
      supabase,
      "delinquency_actions",
      "id, kind, unit_number, amount, created_at, deleted_at",
      (q) => q.in("kind", ["fed_filed", "eviction_completed"]).gte("created_at", since),
    ),
    readAll<Record<string, unknown>>(
      supabase,
      "mlgw_bills",
      "id, mlgw_account_id, bill_date, amount_due, balance_forward",
      (q) => q.gte("bill_date", utilitySince),
    ),
    readAll<Record<string, unknown>>(
      supabase,
      "mlgw_accounts",
      "id, unit_number, is_house_account",
    ),
    loadNotified(supabase),
  ]);

  const leasesById = new Map<string, Record<string, unknown>>();
  for (const lease of [...applied, ...signed]) {
    leasesById.set(String(lease.resman_lease_id ?? ""), lease);
  }
  const leases = [...leasesById.values()] as never[];

  // --- detect ---------------------------------------------------------------
  const pass = detectManagerAlerts({
    leases,
    units: units as never[],
    delinquencyActions: actions as never[],
    utilityBills: bills as never[],
    utilityAccounts: accounts as never[],
    notified,
    nowIso,
    balanceThreshold: params.balanceThreshold,
  });
  for (const alert of pass.alerts) perKind[alert.kind] += 1;

  const rearmed = await rearmBalances(supabase, pass.rearmedUnitIds);
  const devices = await loadManagerDevices(supabase);

  if (pass.alerts.length === 0) {
    log(`[manager-alerts] nothing to send (devices=${devices.length} rearmed=${rearmed})`);
    return {
      detected: 0,
      claimed: 0,
      sent: 0,
      failed: 0,
      devices: devices.length,
      rearmed,
      perKind,
    };
  }

  // --- claim, then send -----------------------------------------------------
  // Claimed even when no device is registered: an alert is an event, and
  // queueing weeks of them for whoever installs the app first would be worse
  // than dropping them (the state is still visible in the app's own screens).
  const claimed = params.dryRun
    ? []
    : await claimAlerts(supabase, pass.alerts, devices.length, now);

  if (params.dryRun) {
    log(
      `[manager-alerts] DRY RUN detected=${pass.alerts.length} devices=${devices.length} ` +
        `rearmed=${rearmed} (nothing claimed or sent)`,
    );
    return {
      detected: pass.alerts.length,
      claimed: 0,
      sent: 0,
      failed: 0,
      devices: devices.length,
      rearmed,
      perKind,
    };
  }

  const messages = claimed.flatMap((alert) => buildManagerPushMessages(alert, devices));
  const outcome =
    messages.length > 0
      ? await sendExpoPushMessages(messages, { log })
      : { sent: 0, failed: 0, invalidTokens: [] as string[] };
  await deactivateTokens(supabase, outcome.invalidTokens, log);

  log(
    `[manager-alerts] detected=${pass.alerts.length} claimed=${claimed.length} ` +
      `devices=${devices.length} messages=${messages.length} sent=${outcome.sent} ` +
      `failed=${outcome.failed} invalidTokens=${outcome.invalidTokens.length} rearmed=${rearmed} ` +
      `perKind=${JSON.stringify(perKind)}`,
  );

  return {
    detected: pass.alerts.length,
    claimed: claimed.length,
    sent: outcome.sent,
    failed: outcome.failed,
    devices: devices.length,
    rearmed,
    perKind,
  };
}
