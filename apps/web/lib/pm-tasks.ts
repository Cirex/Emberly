import type { Database } from "@/types/database";
import type { UntypedSupabase } from "@/lib/supabase/types";
import { currentRoundKey, type PmTemplateRow } from "@/lib/pm-templates";

/**
 * Preventive-maintenance tasks — the mobile check-off surface.
 *
 * The maintenance app reads the current round (active templates expanded into
 * per-unit pm_tasks by the nightly worker) and writes task status as techs
 * check units off. This is the field-side complement to lib/pm-templates.ts
 * (admin CRUD + overview aggregation): same tables, same round-key math,
 * different consumer. ResMan is never written — checking off a task is an
 * Emberly-only write.
 */

export type PmTaskRow = Database["public"]["Tables"]["pm_tasks"]["Row"];
export type PmTaskStatus = PmTaskRow["status"];

export const PM_TASK_STATUSES: readonly PmTaskStatus[] = ["pending", "done", "skipped"];

/** The pm_tasks columns the mobile payload carries. */
export const PM_TASK_COLUMNS =
  "id, template_id, round_key, unit_number, due_date, status, completed_by, completed_at";

/** One task inside a template group, camelCased for the wire. */
export interface PmTaskPayload {
  id: string;
  unitNumber: string;
  status: PmTaskStatus;
  completedBy: string;
  completedAt: string | null;
}

/** One active template with its tasks for the requested round. */
export interface PmTemplateTasksPayload {
  id: string;
  name: string;
  category: string;
  cadence: PmTemplateRow["cadence"];
  roundKey: string;
  /** All tasks in a round share one due date; null when none are generated. */
  dueDate: string | null;
  tasks: PmTaskPayload[];
}

/** The pm_tasks columns the grouping needs (a subset of PM_TASK_COLUMNS). */
export interface PmTaskGroupInput {
  id: string;
  template_id: string;
  round_key: string;
  unit_number: string;
  due_date: string;
  status: PmTaskStatus;
  completed_by: string;
  completed_at: string | null;
}

function toTaskPayload(task: PmTaskGroupInput): PmTaskPayload {
  return {
    id: task.id,
    unitNumber: task.unit_number,
    status: task.status,
    completedBy: task.completed_by,
    completedAt: task.completed_at,
  };
}

/**
 * Pure assembly of the mobile payload: each ACTIVE template with its tasks for
 * `round` ("YYYY-MM"), or — when round is null — for the template's own
 * current round (cadence/anchor math shared with the admin overview and the
 * generator). Templates with no generated tasks still appear with an empty
 * list so the app can show upcoming rounds; task order is whatever the caller
 * fetched (the query orders by unit_number).
 */
export function buildPmTaskGroups(
  templates: readonly PmTemplateRow[],
  tasks: readonly PmTaskGroupInput[],
  round: string | null,
  nowMs: number,
): PmTemplateTasksPayload[] {
  const tasksByTemplate = new Map<string, PmTaskGroupInput[]>();
  for (const task of tasks) {
    const list = tasksByTemplate.get(task.template_id);
    if (list) list.push(task);
    else tasksByTemplate.set(task.template_id, [task]);
  }

  return templates
    .filter((template) => template.active)
    .map((template) => {
      const roundKey = round ?? currentRoundKey(template.cadence, template.anchor_month, nowMs);
      const own = (tasksByTemplate.get(template.id) ?? []).filter(
        (task) => task.round_key === roundKey,
      );
      return {
        id: template.id,
        name: template.name,
        category: template.category,
        cadence: template.cadence,
        roundKey,
        dueDate: own[0]?.due_date ?? null,
        tasks: own.map(toTaskPayload),
      };
    });
}

/** The columns a status update writes. */
export interface PmTaskStatusPatch {
  status: PmTaskStatus;
  completed_by: string;
  completed_at: string | null;
}

/**
 * Completion stamping: done/skipped record who and when (the caller's explicit
 * name wins over the token label, mirroring how photos attribute actors);
 * setting a task back to pending clears both.
 */
export function pmTaskStatusPatch(
  status: PmTaskStatus,
  actorLabel: string,
  completedBy: string | undefined,
  nowMs: number,
): PmTaskStatusPatch {
  if (status === "pending") {
    return { status, completed_by: "", completed_at: null };
  }
  const name = completedBy?.trim() || actorLabel;
  return { status, completed_by: name, completed_at: new Date(nowMs).toISOString() };
}

// ---- data access (service-role) --------------------------------------------

const TEMPLATE_COLUMNS =
  "id, name, category, cadence, anchor_month, scope_type, scope_values, active, created_by, created_at, updated_at";

/**
 * Active templates with their tasks for `round` (or each template's current
 * round when null), oldest template first, tasks ordered by unit number.
 */
export async function listPmTaskGroups(
  client: UntypedSupabase,
  round: string | null,
  nowMs: number = Date.now(),
): Promise<PmTemplateTasksPayload[]> {
  const templatesRes = await client
    .from("pm_templates")
    .select(TEMPLATE_COLUMNS)
    .eq("active", true)
    .order("created_at", { ascending: true });
  if (templatesRes.error) throw new Error(templatesRes.error.message);
  const templates = (templatesRes.data ?? []) as PmTemplateRow[];
  if (templates.length === 0) return [];

  const roundKeys = new Set(
    templates.map((template) =>
      round ?? currentRoundKey(template.cadence, template.anchor_month, nowMs),
    ),
  );
  const tasksRes = await client
    .from("pm_tasks")
    .select(PM_TASK_COLUMNS)
    .in("template_id", templates.map((template) => template.id))
    .in("round_key", [...roundKeys])
    .order("unit_number", { ascending: true });
  if (tasksRes.error) throw new Error(tasksRes.error.message);
  const tasks = (tasksRes.data ?? []) as PmTaskGroupInput[];

  return buildPmTaskGroups(templates, tasks, round, nowMs);
}

/**
 * Apply a status patch; returns the fresh row, or null when the id is unknown
 * (the route answers 404).
 */
export async function updatePmTaskStatus(
  client: UntypedSupabase,
  id: string,
  patch: PmTaskStatusPatch,
): Promise<PmTaskGroupInput | null> {
  const { data, error } = await client
    .from("pm_tasks")
    .update(patch)
    .eq("id", id)
    .select(PM_TASK_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PmTaskGroupInput | null) ?? null;
}
