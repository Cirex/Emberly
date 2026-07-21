import type { Database } from "@/types/database";
import type { UntypedSupabase } from "@/lib/supabase/types";

/**
 * Preventive-maintenance (PM) templates — admin CRUD + read-side aggregation.
 *
 * Admins define pm_templates here; the nightly sync worker (supabase/sync/
 * src/pm/generate.ts) expands active templates into per-unit pm_tasks rounds.
 * The web admin never generates tasks — it only manages templates and reads
 * rounds, so everything below is either a pure aggregation helper (testable
 * directly) or a thin service-role query.
 */

export type PmTemplateRow = Database["public"]["Tables"]["pm_templates"]["Row"];
export type PmCadence = PmTemplateRow["cadence"];
export type PmScopeType = PmTemplateRow["scope_type"];
export type PmTaskStatus = Database["public"]["Tables"]["pm_tasks"]["Row"]["status"];

export const PM_CADENCES: readonly PmCadence[] = ["monthly", "quarterly", "semiannual", "annual"];
export const PM_SCOPE_TYPES: readonly PmScopeType[] = ["all", "building", "classification"];

/** The pm_tasks columns the aggregations need — keep reads narrow. */
export interface PmTaskLite {
  template_id: string;
  round_key: string;
  status: PmTaskStatus;
  due_date: string;
  completed_at: string | null;
}

// ---- round-key math ---------------------------------------------------------
// Mirrors supabase/sync/src/pm/generate.ts (a separate workspace the web app
// cannot import). The math MUST stay identical to the generator's or the
// "current round" shown here drifts from the rounds the worker creates.

const CADENCE_MONTHS: Record<PmCadence, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

function normalizeAnchor(anchorMonth: number | null | undefined): number {
  return typeof anchorMonth === "number" && Number.isInteger(anchorMonth) && anchorMonth >= 1 && anchorMonth <= 12
    ? anchorMonth
    : 1;
}

/**
 * "YYYY-MM" round key of the cadence period containing `nowMs` (local time).
 * Periods are L months long and always START on the anchor month (default
 * January); see the generator for the full derivation.
 */
export function currentRoundKey(
  cadence: PmCadence,
  anchorMonth: number | null | undefined,
  nowMs: number,
): string {
  const length = CADENCE_MONTHS[cadence] ?? 1;
  const anchor = normalizeAnchor(anchorMonth);
  const now = new Date(nowMs);
  const month = now.getMonth() + 1; // 1-12, local
  const offset = (((month - anchor) % length) + length) % length;
  const startLinear = now.getFullYear() * 12 + (month - 1) - offset;
  const start = new Date(Math.floor(startLinear / 12), startLinear % 12, 1);
  return `${start.getFullYear()}-${pad2(start.getMonth() + 1)}`;
}

// ---- pure aggregation helpers ----------------------------------------------

/**
 * A done task is on time when it was completed by the END of its due date
 * (local calendar day) — due dates are date-only, completions are timestamps.
 */
export function isCompletedOnTime(completedAt: string | null, dueDate: string): boolean {
  if (!completedAt) return false;
  const completed = Date.parse(completedAt);
  if (Number.isNaN(completed)) return false;
  const [y, m, d] = dueDate.split("-").map((part) => Number.parseInt(part, 10));
  if (!y || !m || !d) return false;
  // Local midnight AFTER the due day; completing any time on the due date counts.
  const endOfDueDay = new Date(y, m - 1, d + 1).getTime();
  return completed < endOfDueDay;
}

/**
 * Whole-number on-time percentage over the DONE tasks in `tasks`, or null when
 * nothing is done yet (a meaningless 0% would read as "always late").
 */
export function onTimePercent(tasks: readonly PmTaskLite[]): number | null {
  let done = 0;
  let onTime = 0;
  for (const task of tasks) {
    if (task.status !== "done") continue;
    done += 1;
    if (isCompletedOnTime(task.completed_at, task.due_date)) onTime += 1;
  }
  return done === 0 ? null : Math.round((onTime / done) * 100);
}

export interface PmRoundSummary {
  roundKey: string;
  /** The round's due date (all tasks in a round share one). */
  dueDate: string | null;
  total: number;
  done: number;
  skipped: number;
  pending: number;
}

/** Group one template's tasks by round_key, newest round first. */
export function groupTasksByRound(tasks: readonly PmTaskLite[]): PmRoundSummary[] {
  const rounds = new Map<string, PmRoundSummary>();
  for (const task of tasks) {
    let round = rounds.get(task.round_key);
    if (!round) {
      round = { roundKey: task.round_key, dueDate: null, total: 0, done: 0, skipped: 0, pending: 0 };
      rounds.set(task.round_key, round);
    }
    round.total += 1;
    if (task.status === "done") round.done += 1;
    else if (task.status === "skipped") round.skipped += 1;
    else round.pending += 1;
    if (!round.dueDate) round.dueDate = task.due_date;
  }
  // "YYYY-MM" sorts correctly as a string.
  return [...rounds.values()].sort((a, b) => b.roundKey.localeCompare(a.roundKey));
}

/** Human summary of a template's scope, e.g. "All units" / "Buildings: 3, 4". */
export function scopeSummary(scopeType: PmScopeType, scopeValues: readonly string[]): string {
  if (scopeType === "all") return "All units";
  const values = scopeValues.map((v) => v.trim()).filter((v) => v.length > 0);
  const list = values.length > 0 ? values.join(", ") : "none set";
  if (scopeType === "building") return `Buildings: ${list}`;
  return `Classification: ${list}`;
}

/** Trim, drop empties, and dedupe a scope_values input. */
export function normalizeScopeValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push(value);
  }
  return out;
}

/** Recent rounds kept per template in the overview payload. */
const ROUND_HISTORY_LIMIT = 12;

export interface PmTemplateStats {
  currentRoundKey: string;
  currentDone: number;
  currentTotal: number;
  currentSkipped: number;
  currentPending: number;
  /** Overall on-time % across every done task of the template (null = none done). */
  onTimePercent: number | null;
  rounds: PmRoundSummary[];
}

export interface PmTemplateWithStats extends PmTemplateRow {
  stats: PmTemplateStats;
}

export interface PmOverviewSummary {
  activeTemplates: number;
  /** Pending tasks in each ACTIVE template's current round. */
  dueThisRound: number;
  currentRoundDone: number;
  currentRoundTotal: number;
  /** Done ÷ total across active templates' current rounds (null = no tasks). */
  currentRoundPercent: number | null;
  /** On-time % across every done pm_task, all templates and rounds. */
  overallOnTimePercent: number | null;
}

export interface PmOverview {
  templates: PmTemplateWithStats[];
  summary: PmOverviewSummary;
}

/**
 * Pure assembly of the admin overview: per-template current-round progress and
 * round history, plus the header roll-up. `nowMs` decides which round is
 * "current" for each template's cadence/anchor.
 */
export function buildPmOverview(
  templates: readonly PmTemplateRow[],
  tasks: readonly PmTaskLite[],
  nowMs: number,
): PmOverview {
  const tasksByTemplate = new Map<string, PmTaskLite[]>();
  for (const task of tasks) {
    const list = tasksByTemplate.get(task.template_id);
    if (list) list.push(task);
    else tasksByTemplate.set(task.template_id, [task]);
  }

  let dueThisRound = 0;
  let currentRoundDone = 0;
  let currentRoundTotal = 0;

  const withStats = templates.map((template): PmTemplateWithStats => {
    const own = tasksByTemplate.get(template.id) ?? [];
    const roundKey = currentRoundKey(template.cadence, template.anchor_month, nowMs);
    const rounds = groupTasksByRound(own);
    const current = rounds.find((round) => round.roundKey === roundKey);

    if (template.active) {
      dueThisRound += current?.pending ?? 0;
      currentRoundDone += current?.done ?? 0;
      currentRoundTotal += current?.total ?? 0;
    }

    return {
      ...template,
      stats: {
        currentRoundKey: roundKey,
        currentDone: current?.done ?? 0,
        currentTotal: current?.total ?? 0,
        currentSkipped: current?.skipped ?? 0,
        currentPending: current?.pending ?? 0,
        onTimePercent: onTimePercent(own),
        rounds: rounds.slice(0, ROUND_HISTORY_LIMIT),
      },
    };
  });

  return {
    templates: withStats,
    summary: {
      activeTemplates: templates.filter((t) => t.active).length,
      dueThisRound,
      currentRoundDone,
      currentRoundTotal,
      currentRoundPercent:
        currentRoundTotal === 0 ? null : Math.round((currentRoundDone / currentRoundTotal) * 100),
      overallOnTimePercent: onTimePercent(tasks),
    },
  };
}

// ---- data access (service-role) --------------------------------------------

const TEMPLATE_COLUMNS =
  "id, name, category, cadence, anchor_month, scope_type, scope_values, active, created_by, created_at, updated_at";

const TASK_COLUMNS = "template_id, round_key, status, due_date, completed_at";

/** Every template with stats + the header summary, oldest template first. */
export async function listPmOverview(
  client: UntypedSupabase,
  nowMs: number = Date.now(),
): Promise<PmOverview> {
  const templatesRes = await client
    .from("pm_templates")
    .select(TEMPLATE_COLUMNS)
    .order("created_at", { ascending: true });
  if (templatesRes.error) throw new Error(templatesRes.error.message);
  const templates = (templatesRes.data ?? []) as PmTemplateRow[];

  const tasksRes = await client
    .from("pm_tasks")
    .select(TASK_COLUMNS)
    .order("round_key", { ascending: false });
  if (tasksRes.error) throw new Error(tasksRes.error.message);
  const tasks = (tasksRes.data ?? []) as PmTaskLite[];

  return buildPmOverview(templates, tasks, nowMs);
}

export interface PmTemplateInput {
  name: string;
  category: string;
  cadence: PmCadence;
  anchorMonth: number | null;
  scopeType: PmScopeType;
  scopeValues: string[];
  active: boolean;
}

export async function createPmTemplate(
  client: UntypedSupabase,
  input: PmTemplateInput,
  createdBy: string,
): Promise<PmTemplateRow> {
  const { data, error } = await client
    .from("pm_templates")
    .insert({
      name: input.name,
      category: input.category,
      cadence: input.cadence,
      anchor_month: input.anchorMonth,
      scope_type: input.scopeType,
      scope_values: input.scopeValues,
      active: input.active,
      created_by: createdBy,
    })
    .select(TEMPLATE_COLUMNS)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to create PM template");
  return data as PmTemplateRow;
}

export type PmTemplatePatch = Partial<PmTemplateInput>;

/** Update editable fields; returns the fresh row, or null when the id is gone. */
export async function updatePmTemplate(
  client: UntypedSupabase,
  id: string,
  patch: PmTemplatePatch,
): Promise<PmTemplateRow | null> {
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.category !== undefined) update.category = patch.category;
  if (patch.cadence !== undefined) update.cadence = patch.cadence;
  if (patch.anchorMonth !== undefined) update.anchor_month = patch.anchorMonth;
  if (patch.scopeType !== undefined) update.scope_type = patch.scopeType;
  if (patch.scopeValues !== undefined) update.scope_values = patch.scopeValues;
  if (patch.active !== undefined) update.active = patch.active;

  const { data, error } = await client
    .from("pm_templates")
    .update(update)
    .eq("id", id)
    .select(TEMPLATE_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PmTemplateRow | null) ?? null;
}

/** Delete a template (pm_tasks cascade). False when the id doesn't exist. */
export async function deletePmTemplate(client: UntypedSupabase, id: string): Promise<boolean> {
  const existing = await client.from("pm_templates").select("id").eq("id", id).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (!existing.data) return false;

  const { error } = await client.from("pm_templates").delete().eq("id", id);
  if (error) throw new Error(error.message);
  return true;
}
