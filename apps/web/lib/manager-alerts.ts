/**
 * Manager push alerts — pure detectors + notification copy.
 *
 * The manager app (apps/manager) subscribes to five operational alerts. This
 * module owns the RULES and the COPY for all of them; it has no imports, no
 * Supabase, and no I/O so it can be unit-tested directly (tests/manager-alerts.test.js)
 * and mirrored byte-for-byte into the sync worker, which is what actually
 * queries the database and sends the pushes.
 *
 * ⚠️ MIRRORED FILE — two paths hold byte-for-byte identical copies:
 *     apps/web/lib/manager-alerts.ts            (canonical; tested here)
 *     supabase/sync/src/manager/alert-rules.ts  (what the worker imports)
 * The sync worker cannot import across `apps/` — its tsconfig pins
 * `rootDir: src`, so any cross-app import is a TS6059 build error — and
 * packages/* is out of scope for this change, so a checked copy is the seam.
 * supabase/sync/tests/manager-alerts.test.js diffs the two files and fails if
 * they ever drift: edit one, then `cp` it over the other.
 *
 * PII-LIGHT BY CONTRACT: notification bodies may name unit numbers, dates, and
 * dollar amounts. They must never carry resident names, contact details, or
 * anything else that identifies a person — a push renders on a lock screen.
 *
 * IDEMPOTENCY: every alert carries a `subjectKey` that, paired with its `kind`,
 * is the natural key of public.manager_alert_notifications. The caller claims
 * that row BEFORE sending, so an alert can fire at most once. Detectors are
 * told which subject keys are already claimed and skip them; only
 * `balance_threshold` can ever re-arm (see detectBalanceThreshold).
 *
 * FIRST-RUN GUARD: the ledger starts empty, so "not yet notified" alone would
 * fire the entire history on the first run. Every detector additionally
 * requires its source row to be recent (ALERT_FRESHNESS_DAYS), which bounds the
 * cold-start burst to the last two weeks of activity.
 */

// ---- kinds & routing -------------------------------------------------------

export type ManagerAlertKind =
  | "application_received"
  | "lease_signed"
  | "balance_threshold"
  | "eviction_milestone"
  | "utility_spike";

/** Every alert kind, in the order the settings screen lists them. */
export const MANAGER_ALERT_KINDS = [
  "application_received",
  "lease_signed",
  "balance_threshold",
  "eviction_milestone",
  "utility_spike",
] as const satisfies readonly ManagerAlertKind[];

/** In-app destination per kind — the manager app's tab routes. */
export const MANAGER_ALERT_ROUTES: Record<ManagerAlertKind, string> = {
  application_received: "/(tabs)/leasing",
  lease_signed: "/(tabs)/leasing",
  balance_threshold: "/(tabs)/delinquency",
  eviction_milestone: "/(tabs)/delinquency",
  utility_spike: "/(tabs)/utilities",
};

export function isManagerAlertKind(value: unknown): value is ManagerAlertKind {
  return (
    typeof value === "string" &&
    (MANAGER_ALERT_KINDS as readonly string[]).includes(value)
  );
}

// ---- thresholds (documented constants, exported for tests) -----------------

/** A source row older than this never alerts — the cold-start burst guard. */
export const ALERT_FRESHNESS_DAYS = 14;

/** Default upward crossing point for the balance alert, in dollars. */
export const DEFAULT_BALANCE_THRESHOLD = 1500;

/**
 * Re-arm band for the balance alert: once a unit has alerted, it only becomes
 * eligible again after its balance falls below `threshold * this`. Without the
 * band a unit hovering at $1,500.00 would alert on every payment/charge pair.
 */
export const BALANCE_REARM_RATIO = 0.9;

/** Utility spike: new charges at or above this multiple of a typical bill. */
export const UTILITY_SPIKE_RATIO = 1.75;

/** ...and at least this many dollars, so trivial bills never flag. */
export const UTILITY_SPIKE_MIN_AMOUNT = 40;

/** Delinquency action kinds that count as an eviction milestone. */
export const EVICTION_MILESTONE_KINDS = ["fed_filed", "eviction_completed"] as const;

export type EvictionMilestone = (typeof EVICTION_MILESTONE_KINDS)[number];

// ---- alert shape -----------------------------------------------------------

export interface ManagerAlert {
  kind: ManagerAlertKind;
  title: string;
  /** PII-light: unit numbers, dates, and amounts only. */
  body: string;
  data: { route: string; id?: string };
  /** Ledger natural key tail — unique per (kind, subjectKey). */
  subjectKey: string;
  /** Unit number for the ledger row; "" when the source row had none. */
  unitNumber: string;
  /** Dollar figure behind the alert, for the ledger row; null when N/A. */
  amount: number | null;
}

// ---- formatting helpers (pure, locale-independent) -------------------------

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
      ? Number(v)
      : 0;

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** "YYYY-MM-DD" prefix of an ISO date/timestamp; "" when unusable. */
export function isoDay(value: unknown): string {
  const raw = text(value);
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : "";
}

/**
 * "$1,820.45" — hand-rolled rather than Intl so the copy is byte-identical in
 * every runtime the mirror runs in (Next.js server, Bun worker, tests).
 */
export function formatUsd(value: number): string {
  const rounded = Math.round(Math.abs(value) * 100) / 100;
  const [whole, cents] = rounded.toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${value < 0 ? "-" : ""}$${grouped}.${cents}`;
}

/** "2026-07-18" → "Jul 18". Returns "" for anything unparseable. */
export function formatShortDate(value: unknown): string {
  const day = isoDay(value);
  if (!day) return "";
  const month = Number(day.slice(5, 7));
  if (month < 1 || month > 12) return "";
  return `${MONTHS[month - 1]} ${Number(day.slice(8, 10))}`;
}

/** Unit label for copy; falls back to a neutral phrase when unknown. */
export function unitLabel(unitNumber: unknown): string {
  const unit = text(unitNumber);
  return unit ? `Unit ${unit}` : "Unassigned unit";
}

/** Join non-empty body fragments with the app's separator. */
function bodyOf(parts: ReadonlyArray<string>): string {
  return parts.filter((p) => p.length > 0).join(" · ");
}

/** Days between two "YYYY-MM-DD" days; NaN-safe, negative when `day` is later. */
export function daysBetween(day: string, reference: string): number {
  const a = Date.parse(`${day}T00:00:00Z`);
  const b = Date.parse(`${reference}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.round((b - a) / 86_400_000);
}

/** True when `day` is within ALERT_FRESHNESS_DAYS before `nowIso` (not future-far). */
export function isFresh(day: string, nowIso: string, windowDays = ALERT_FRESHNESS_DAYS): boolean {
  if (!day) return false;
  const age = daysBetween(day, isoDay(nowIso));
  if (!Number.isFinite(age)) return false;
  // Future-dated rows (data entry quirks) are treated as fresh, not skipped.
  return age <= windowDays;
}

// ---- copy builder ----------------------------------------------------------

export type ManagerAlertContext =
  | { kind: "application_received"; unitNumber: string; leaseId: string; applicationDate: string }
  | { kind: "lease_signed"; unitNumber: string; leaseId: string; signedDate: string }
  | {
      kind: "balance_threshold";
      unitNumber: string;
      unitId: string;
      balance: number;
      threshold: number;
    }
  | {
      kind: "eviction_milestone";
      unitNumber: string;
      actionId: string;
      milestone: EvictionMilestone;
      amount: number | null;
    }
  | {
      kind: "utility_spike";
      unitNumber: string;
      billId: string;
      charges: number;
      typical: number;
    };

/**
 * The single place notification copy is written. Titles are sentence case and
 * say WHAT happened; bodies lead with the unit and add the one number a
 * manager needs to triage from the lock screen.
 */
export function buildManagerAlert(context: ManagerAlertContext): ManagerAlert {
  const route = MANAGER_ALERT_ROUTES[context.kind];
  switch (context.kind) {
    case "application_received":
      return {
        kind: context.kind,
        title: "Application received",
        body: bodyOf([unitLabel(context.unitNumber), formatShortDate(context.applicationDate)]),
        data: { route, id: context.leaseId },
        subjectKey: context.leaseId,
        unitNumber: text(context.unitNumber),
        amount: null,
      };
    case "lease_signed":
      return {
        kind: context.kind,
        title: "Lease signed",
        body: bodyOf([unitLabel(context.unitNumber), formatShortDate(context.signedDate)]),
        data: { route, id: context.leaseId },
        subjectKey: context.leaseId,
        unitNumber: text(context.unitNumber),
        amount: null,
      };
    case "balance_threshold":
      return {
        kind: context.kind,
        title: `Balance over ${formatUsd(context.threshold)}`,
        body: bodyOf([unitLabel(context.unitNumber), `balance ${formatUsd(context.balance)}`]),
        data: { route, id: context.unitId },
        subjectKey: context.unitId,
        unitNumber: text(context.unitNumber),
        amount: Math.round(context.balance * 100) / 100,
      };
    case "eviction_milestone":
      return {
        kind: context.kind,
        title: context.milestone === "fed_filed" ? "FED filed" : "Eviction completed",
        body: bodyOf([
          unitLabel(context.unitNumber),
          context.amount !== null && context.amount > 0 ? formatUsd(context.amount) : "",
        ]),
        data: { route, id: context.actionId },
        subjectKey: context.actionId,
        unitNumber: text(context.unitNumber),
        amount: context.amount === null ? null : Math.round(context.amount * 100) / 100,
      };
    case "utility_spike":
      return {
        kind: context.kind,
        title: "Utility spike",
        body: bodyOf([
          unitLabel(context.unitNumber),
          `${formatUsd(context.charges)} vs ${formatUsd(context.typical)} typical`,
        ]),
        data: { route, id: context.billId },
        subjectKey: context.billId,
        unitNumber: text(context.unitNumber),
        amount: Math.round(context.charges * 100) / 100,
      };
  }
}

// ---- source row shapes -----------------------------------------------------

/** resman_leases slice. */
export interface LeaseAlertRow {
  resman_lease_id: string;
  unit_number?: string | null;
  application_date?: string | null;
  signed_date?: string | null;
}

/** resman_units slice. */
export interface UnitBalanceRow {
  resman_unit_id: string;
  number?: string | null;
  balance?: number | string | null;
}

/** delinquency_actions slice. */
export interface DelinquencyActionRow {
  id: string;
  kind: string;
  unit_number?: string | null;
  amount?: number | string | null;
  created_at?: string | null;
  deleted_at?: string | null;
}

/** mlgw_bills slice. */
export interface UtilityBillRow {
  id: string;
  mlgw_account_id?: string | null;
  bill_date?: string | null;
  amount_due?: number | string | null;
  balance_forward?: number | string | null;
}

/** mlgw_accounts slice. */
export interface UtilityAccountRow {
  id: string;
  unit_number?: string | null;
  is_house_account?: boolean | null;
}

// ---- detectors -------------------------------------------------------------

/**
 * Leases whose application_date landed inside the freshness window and that
 * have not been announced yet. One alert per lease, forever (the ledger row
 * keyed on the lease id is never cleared).
 */
export function detectApplicationReceived(
  leases: ReadonlyArray<LeaseAlertRow>,
  notified: ReadonlySet<string>,
  options: { nowIso: string; freshnessDays?: number },
): ManagerAlert[] {
  const out: ManagerAlert[] = [];
  for (const lease of leases) {
    const leaseId = text(lease.resman_lease_id);
    if (!leaseId || notified.has(leaseId)) continue;
    const applicationDate = isoDay(lease.application_date);
    if (!isFresh(applicationDate, options.nowIso, options.freshnessDays)) continue;
    out.push(
      buildManagerAlert({
        kind: "application_received",
        unitNumber: text(lease.unit_number),
        leaseId,
        applicationDate,
      }),
    );
  }
  return out;
}

/**
 * Leases whose signed_date is newly set. "Newly" is the same two-part test as
 * applications: inside the freshness window and not already in the ledger.
 */
export function detectLeaseSigned(
  leases: ReadonlyArray<LeaseAlertRow>,
  notified: ReadonlySet<string>,
  options: { nowIso: string; freshnessDays?: number },
): ManagerAlert[] {
  const out: ManagerAlert[] = [];
  for (const lease of leases) {
    const leaseId = text(lease.resman_lease_id);
    if (!leaseId || notified.has(leaseId)) continue;
    const signedDate = isoDay(lease.signed_date);
    if (!isFresh(signedDate, options.nowIso, options.freshnessDays)) continue;
    out.push(
      buildManagerAlert({
        kind: "lease_signed",
        unitNumber: text(lease.unit_number),
        leaseId,
        signedDate,
      }),
    );
  }
  return out;
}

export interface BalanceThresholdResult {
  alerts: ManagerAlert[];
  /**
   * Units whose balance has fallen back below the re-arm band. The caller
   * DELETES their ledger rows so a future climb over the threshold alerts
   * again — this is the one kind that is allowed to fire more than once.
   */
  rearmedUnitIds: string[];
}

/**
 * Units crossing the balance threshold upward.
 *
 * The mirror only carries the CURRENT balance, never the previous one, so
 * "crossing upward" is modelled with the ledger + a hysteresis band rather
 * than a delta: a unit at or above `threshold` with no ledger row alerts and
 * is claimed; a claimed unit is silent until its balance drops below
 * `threshold * BALANCE_REARM_RATIO`, which clears the claim.
 *
 * NOT freshness-gated — a balance is a standing state, not an event; the
 * ledger alone bounds it (a first run alerts once per already-delinquent unit,
 * which is the intended "here is your delinquency list" moment).
 */
export function detectBalanceThreshold(
  units: ReadonlyArray<UnitBalanceRow>,
  notified: ReadonlySet<string>,
  options: { threshold?: number } = {},
): BalanceThresholdResult {
  const threshold = options.threshold ?? DEFAULT_BALANCE_THRESHOLD;
  const rearmAt = threshold * BALANCE_REARM_RATIO;
  const alerts: ManagerAlert[] = [];
  const rearmedUnitIds: string[] = [];
  for (const unit of units) {
    const unitId = text(unit.resman_unit_id);
    if (!unitId) continue;
    const balance = num(unit.balance);
    const claimed = notified.has(unitId);
    if (claimed) {
      if (balance < rearmAt) rearmedUnitIds.push(unitId);
      continue;
    }
    if (balance < threshold) continue;
    alerts.push(
      buildManagerAlert({
        kind: "balance_threshold",
        unitNumber: text(unit.number),
        unitId,
        balance,
        threshold,
      }),
    );
  }
  return { alerts, rearmedUnitIds };
}

/**
 * Live delinquency_actions rows recording an eviction milestone (fed_filed or
 * eviction_completed). Soft-deleted rows never alert; a row soft-deleted after
 * its alert fired stays claimed (the push already went out).
 */
export function detectEvictionMilestones(
  actions: ReadonlyArray<DelinquencyActionRow>,
  notified: ReadonlySet<string>,
  options: { nowIso: string; freshnessDays?: number },
): ManagerAlert[] {
  const out: ManagerAlert[] = [];
  for (const action of actions) {
    const actionId = text(action.id);
    if (!actionId || notified.has(actionId)) continue;
    if (text(action.deleted_at)) continue;
    const kind = text(action.kind);
    if (!(EVICTION_MILESTONE_KINDS as readonly string[]).includes(kind)) continue;
    if (!isFresh(isoDay(action.created_at), options.nowIso, options.freshnessDays)) continue;
    const amount = action.amount === null || action.amount === undefined ? null : num(action.amount);
    out.push(
      buildManagerAlert({
        kind: "eviction_milestone",
        unitNumber: text(action.unit_number),
        actionId,
        milestone: kind as EvictionMilestone,
        amount,
      }),
    );
  }
  return out;
}

/**
 * Portfolio-wide average NEW CHARGES per bill across bills billed strictly
 * before `nowIso`'s month. 0 when there is no usable history.
 *
 * DOCUMENTED APPROXIMATION (ported from the manager app's utility-exceptions
 * engine): the feed carries no reliable per-account bill history, so "typical"
 * is the portfolio's average bill rather than this account's own average. That
 * makes `utility_spike` a "well above a typical bill here" signal, not a strict
 * per-meter delta — which is also why house/master meters are excluded below:
 * they are structurally larger than a per-unit bill and would always fire.
 */
export function typicalUtilityCharges(
  bills: ReadonlyArray<UtilityBillRow>,
  nowIso: string,
): number {
  const currentMonth = isoDay(nowIso).slice(0, 7);
  let total = 0;
  let count = 0;
  for (const bill of bills) {
    const month = isoDay(bill.bill_date).slice(0, 7);
    if (!month || (currentMonth && month >= currentMonth)) continue;
    total += num(bill.amount_due) - num(bill.balance_forward);
    count += 1;
  }
  return count > 0 ? total / count : 0;
}

/**
 * Bills whose new charges (amount_due − balance_forward) are at least
 * UTILITY_SPIKE_RATIO× the typical bill and at least UTILITY_SPIKE_MIN_AMOUNT.
 * Unit accounts only; freshness-gated on bill_date so a historical import
 * cannot flood the fleet.
 */
export function detectUtilitySpikes(
  bills: ReadonlyArray<UtilityBillRow>,
  accounts: ReadonlyArray<UtilityAccountRow>,
  notified: ReadonlySet<string>,
  options: { nowIso: string; freshnessDays?: number },
): ManagerAlert[] {
  const byId = new Map<string, UtilityAccountRow>();
  for (const account of accounts) byId.set(text(account.id), account);
  const typical = typicalUtilityCharges(bills, options.nowIso);
  if (typical <= 0) return [];

  const out: ManagerAlert[] = [];
  for (const bill of bills) {
    const billId = text(bill.id);
    if (!billId || notified.has(billId)) continue;
    const account = byId.get(text(bill.mlgw_account_id));
    if (!account || account.is_house_account === true) continue;
    const billDate = isoDay(bill.bill_date);
    if (!isFresh(billDate, options.nowIso, options.freshnessDays)) continue;
    const charges = num(bill.amount_due) - num(bill.balance_forward);
    if (charges < UTILITY_SPIKE_MIN_AMOUNT) continue;
    if (charges < UTILITY_SPIKE_RATIO * typical) continue;
    out.push(
      buildManagerAlert({
        kind: "utility_spike",
        unitNumber: text(account.unit_number),
        billId,
        charges,
        typical,
      }),
    );
  }
  return out;
}

// ---- the whole pass --------------------------------------------------------

export interface ManagerAlertInput {
  leases: ReadonlyArray<LeaseAlertRow>;
  units: ReadonlyArray<UnitBalanceRow>;
  delinquencyActions: ReadonlyArray<DelinquencyActionRow>;
  utilityBills: ReadonlyArray<UtilityBillRow>;
  utilityAccounts: ReadonlyArray<UtilityAccountRow>;
  /** Already-claimed subject keys, per kind (from manager_alert_notifications). */
  notified: Record<ManagerAlertKind, ReadonlySet<string>>;
  /** ISO instant the pass runs at — injected for purity. */
  nowIso: string;
  balanceThreshold?: number;
  freshnessDays?: number;
}

export interface ManagerAlertPass {
  alerts: ManagerAlert[];
  rearmedUnitIds: string[];
}

/** An empty per-kind claim map — convenience for callers and tests. */
export function emptyNotifiedMap(): Record<ManagerAlertKind, ReadonlySet<string>> {
  return {
    application_received: new Set<string>(),
    lease_signed: new Set<string>(),
    balance_threshold: new Set<string>(),
    eviction_milestone: new Set<string>(),
    utility_spike: new Set<string>(),
  };
}

/**
 * Run every detector. Alerts come back in MANAGER_ALERT_KINDS order so the
 * send is deterministic (and so tests can assert on it).
 */
export function detectManagerAlerts(input: ManagerAlertInput): ManagerAlertPass {
  const dates = { nowIso: input.nowIso, freshnessDays: input.freshnessDays };
  const balance = detectBalanceThreshold(input.units, input.notified.balance_threshold, {
    threshold: input.balanceThreshold,
  });
  return {
    alerts: [
      ...detectApplicationReceived(input.leases, input.notified.application_received, dates),
      ...detectLeaseSigned(input.leases, input.notified.lease_signed, dates),
      ...balance.alerts,
      ...detectEvictionMilestones(
        input.delinquencyActions,
        input.notified.eviction_milestone,
        dates,
      ),
      ...detectUtilitySpikes(
        input.utilityBills,
        input.utilityAccounts,
        input.notified.utility_spike,
        dates,
      ),
    ],
    rearmedUnitIds: balance.rearmedUnitIds,
  };
}

// ---- per-device fan-out ----------------------------------------------------

/** A registered manager device: its Expo token and its enabled alert kinds. */
export interface ManagerDevice {
  expoPushToken: string;
  /** Empty = no recorded preference = every kind (legacy rows). */
  alertKinds: ReadonlyArray<string>;
}

/** True when this device wants the kind (empty preference list = wants all). */
export function deviceWantsKind(device: ManagerDevice, kind: ManagerAlertKind): boolean {
  return device.alertKinds.length === 0 || device.alertKinds.includes(kind);
}

/** The tokens an alert should be sent to, given the registered fleet. */
export function tokensForAlert(
  devices: ReadonlyArray<ManagerDevice>,
  kind: ManagerAlertKind,
): string[] {
  return devices
    .filter((device) => device.expoPushToken.length > 0 && deviceWantsKind(device, kind))
    .map((device) => device.expoPushToken);
}
