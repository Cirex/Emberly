/**
 * Preventive-maintenance (PM) round generation — pure logic, no I/O.
 *
 * Admins define pm_templates; the nightly job expands each ACTIVE template into
 * the CURRENT period's per-unit pm_tasks rows. Everything here is deterministic
 * over its inputs (`nowMs` included), so re-running with the same inputs yields
 * the same rows — the database's unique (template_id, round_key, unit_number)
 * plus INSERT ... ON CONFLICT DO NOTHING makes the nightly run idempotent and
 * keeps completed/skipped tasks from being clobbered.
 *
 * All date math is in LOCAL time (the worker runs in the property's timezone),
 * matching how due dates are understood on site.
 */

export type PmCadence = "monthly" | "quarterly" | "semiannual" | "annual";

/** Months per period for each cadence. */
const CADENCE_MONTHS: Record<PmCadence, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

/** Row shape read from public.pm_templates (subset the generator needs). */
export interface PmTemplate {
  id: string;
  name: string;
  cadence: string;
  anchor_month: number | null;
  scope_type: string;
  scope_values: string[] | null;
  active: boolean;
}

/** Row shape read from the resman_units mirror (subset the generator needs). */
export interface MirrorUnit {
  number: string;
  resman_building_id: string | null;
  classification: string | null;
  /** ResMan flag: unit doesn't count toward occupancy (office, model, down). */
  excluded_from_occupancy: boolean | null;
  /** ResMan flag: holding unit (not a real rentable unit). */
  holding_unit: boolean | null;
}

/** Row shape read from the resman_buildings mirror. */
export interface MirrorBuilding {
  resman_building_id: string;
  name: string | null;
}

/** Row shape upserted into public.pm_tasks. */
export interface PmTaskRow {
  template_id: string;
  round_key: string;
  unit_number: string;
  due_date: string; // YYYY-MM-DD (local)
  status: "pending";
}

/** Resolve months-per-period, throwing loudly on a cadence outside the DB CHECK set. */
function cadenceMonths(cadence: string): number {
  const months = CADENCE_MONTHS[cadence as PmCadence];
  if (!months) throw new Error(`Unknown PM cadence: ${JSON.stringify(cadence)}`);
  return months;
}

/**
 * Normalize anchor_month: null (or anything not an integer 1-12, which the DB
 * CHECK already forbids) defaults to January.
 */
function normalizeAnchor(anchorMonth: number | null | undefined): number {
  return typeof anchorMonth === "number" && Number.isInteger(anchorMonth) && anchorMonth >= 1 && anchorMonth <= 12
    ? anchorMonth
    : 1;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Local-time start (ms) of the cadence period containing `nowMs`.
 *
 * The math: periods are `L` months long (monthly 1, quarterly 3, semiannual 6,
 * annual 12) and the cycle is anchored so that a period always STARTS on the
 * anchor month (default January). With the local calendar month `M` (1-12):
 *
 *   offset = ((M - anchor) mod L + L) mod L   // months since the period began;
 *                                             // double-mod keeps it in 0..L-1
 *                                             // for negative M - anchor
 *   period start = the 1st of (M - offset), borrowing a year when it lands
 *                  at or before month 0.
 *
 * Examples: quarterly anchor 4 → periods start Apr/Jul/Oct/Jan, so May 2026
 * falls in the period starting 2026-04-01. Semiannual anchor 10 → periods
 * start Oct/Apr, so February 2026 falls in the period starting 2025-10-01
 * (year wrap). Monthly has L = 1, so offset is always 0 and the anchor is
 * irrelevant: the period is simply the current month.
 */
export function periodStartMs(cadence: string, anchorMonth: number | null | undefined, nowMs: number): number {
  const length = cadenceMonths(cadence);
  const anchor = normalizeAnchor(anchorMonth);
  const now = new Date(nowMs);
  const month = now.getMonth() + 1; // 1-12, local
  const offset = (((month - anchor) % length) + length) % length;
  // Work in linear month-space (year*12 + monthIndex) so the year borrow on
  // wrap (e.g. Feb minus 4 months → previous October) falls out of the division.
  const startLinear = now.getFullYear() * 12 + (month - 1) - offset;
  return new Date(Math.floor(startLinear / 12), startLinear % 12, 1).getTime();
}

/**
 * Deterministic key for the period containing `nowMs`: the "YYYY-MM" of the
 * period start (local). Monthly is the current month; quarterly/semiannual/
 * annual key off the anchor-month cycle (see periodStartMs).
 */
export function roundKeyFor(cadence: string, anchorMonth: number | null | undefined, nowMs: number): string {
  const start = new Date(periodStartMs(cadence, anchorMonth, nowMs));
  return `${start.getFullYear()}-${pad2(start.getMonth() + 1)}`;
}

/**
 * Due date for the current period: period start + 14 days (always the 15th of
 * the period's first month), formatted YYYY-MM-DD in local time. The +14 is
 * applied on calendar fields, so a DST transition inside the window can't
 * shift the date.
 */
export function dueDateFor(cadence: string, anchorMonth: number | null | undefined, nowMs: number): string {
  const start = new Date(periodStartMs(cadence, anchorMonth, nowMs));
  const due = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 14);
  return `${due.getFullYear()}-${pad2(due.getMonth() + 1)}-${pad2(due.getDate())}`;
}

const normalized = (value: string | null | undefined): string => (value ?? "").trim().toLowerCase();

/**
 * Units a template applies to.
 *
 * Exclusions (all scope types): units flagged `excluded_from_occupancy` or
 * `holding_unit` (office/model/down/holding units — not real serviceable
 * homes) and units with a blank unit number are never in scope. Both flags are
 * nullable booleans on the resman_units mirror; null/false means include.
 *
 * Scope matching:
 *  - 'all'            → every eligible unit.
 *  - 'classification' → the unit's resman_units.classification is in
 *                       scope_values, matched case-insensitively (trimmed).
 *  - 'building'       → the unit's building NAME (resman_buildings mirror,
 *                       joined via resman_units.resman_building_id) is in
 *                       scope_values, case-insensitively. Units without a
 *                       building, or whose building id is missing from the
 *                       mirror, never match.
 *  - a scoped template with an empty scope_values matches nothing (safe
 *    default — a half-configured template generates no tasks), as does an
 *    unknown scope_type.
 */
export function unitsInScope(
  template: Pick<PmTemplate, "scope_type" | "scope_values">,
  units: MirrorUnit[],
  buildings: MirrorBuilding[] = [],
): MirrorUnit[] {
  const eligible = units.filter(
    (u) => u.excluded_from_occupancy !== true && u.holding_unit !== true && (u.number ?? "").trim().length > 0,
  );
  const scopeType = template.scope_type || "all";
  if (scopeType === "all") return eligible;

  const wanted = new Set((template.scope_values ?? []).map(normalized).filter((v) => v.length > 0));
  if (wanted.size === 0) return [];

  if (scopeType === "classification") {
    return eligible.filter((u) => wanted.has(normalized(u.classification)));
  }
  if (scopeType === "building") {
    const nameById = new Map(buildings.map((b) => [b.resman_building_id, normalized(b.name)]));
    return eligible.filter((u) => {
      const name = u.resman_building_id ? nameById.get(u.resman_building_id) : undefined;
      return !!name && wanted.has(name);
    });
  }
  return [];
}

export interface GeneratePmTasksInput {
  templates: PmTemplate[];
  units: MirrorUnit[];
  buildings: MirrorBuilding[];
  nowMs: number;
}

/**
 * Expand every ACTIVE template into the CURRENT period's pm_tasks rows.
 *
 * Output is deterministic: templates in input order, units sorted by unit
 * number within each template, duplicate unit numbers collapsed (first wins —
 * the DB unique key is (template_id, round_key, unit_number), so two mirror
 * units sharing a number can only ever be one task). Inactive templates are
 * skipped entirely.
 */
export function generatePmTasks(input: GeneratePmTasksInput): PmTaskRow[] {
  const rows: PmTaskRow[] = [];
  for (const template of input.templates) {
    if (!template.active) continue;
    const roundKey = roundKeyFor(template.cadence, template.anchor_month, input.nowMs);
    const dueDate = dueDateFor(template.cadence, template.anchor_month, input.nowMs);
    const scoped = [...unitsInScope(template, input.units, input.buildings)].sort((a, b) =>
      a.number.localeCompare(b.number),
    );
    const seen = new Set<string>();
    for (const unit of scoped) {
      const unitNumber = unit.number.trim();
      if (seen.has(unitNumber)) continue;
      seen.add(unitNumber);
      rows.push({
        template_id: template.id,
        round_key: roundKey,
        unit_number: unitNumber,
        due_date: dueDate,
        status: "pending",
      });
    }
  }
  return rows;
}
