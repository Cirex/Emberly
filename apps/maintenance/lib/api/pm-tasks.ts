import { z } from "zod";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * Device-side client for Emberly preventive-maintenance rounds. The server
 * groups active templates' current-round pm_tasks by template
 * (GET /api/resman/pm-tasks); checking a unit off is a status POST — an
 * Emberly-only write, ResMan is never touched. Same Bearer auth and outcome
 * classification as the work-order photo client.
 */

/** Machine values, never translated (AGENTS.md · Localization). */
export const PM_TASK_STATUSES = ["pending", "done", "skipped"] as const;
export type PmTaskStatus = (typeof PM_TASK_STATUSES)[number];

/** Injectable for tests — the app always passes the global fetch. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const BASE = "/api/resman/pm-tasks";

export const PmTaskSchema = z.object({
  id: z.string(),
  unitNumber: z.string(),
  status: z.enum(PM_TASK_STATUSES),
  completedBy: z.string(),
  completedAt: z.string().nullable(),
});
export type PmTask = z.infer<typeof PmTaskSchema>;

export const PmTemplateRoundSchema = z.object({
  id: z.string(),
  name: z.string(),
  // String-tolerant like the work-order enums: a widened cadence set upstream
  // must degrade to a raw label, never throw.
  cadence: z.string(),
  category: z.string(),
  roundKey: z.string(),
  dueDate: z.string().nullable(),
  tasks: z.array(PmTaskSchema),
});
export type PmTemplateRound = z.infer<typeof PmTemplateRoundSchema>;

const ListResponseSchema = z.object({
  data: z.object({ templates: z.array(PmTemplateRoundSchema) }),
});

/** GET the current round: active templates with their tasks. */
export async function listPmTemplateRounds(
  config: StaffConfig,
  fetchImpl: FetchLike = fetch,
): Promise<PmTemplateRound[]> {
  const res = await fetchImpl(`${config.baseUrl}${BASE}`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (res.status === 401 || res.status === 403) throw new Error("Not authorized for the ResMan API");
  if (!res.ok) throw new Error(`Failed to load preventive maintenance (${res.status})`);
  return ListResponseSchema.parse(await res.json()).data.templates;
}

const UpdateResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    status: z.enum(PM_TASK_STATUSES),
    completedBy: z.string(),
    completedAt: z.string().nullable(),
  }),
});
export type PmTaskUpdate = z.infer<typeof UpdateResponseSchema>["data"];

export type PmTaskUpdateOutcome =
  | { ok: true; task: PmTaskUpdate }
  /** retry: transient (throttling, server trouble). A 404 is NOT retryable —
   *  these are first-party rows, so a missing id means the template or round
   *  was deleted and only a fresh list fixes the view. */
  | { ok: false; retry: boolean; status: number };

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * POST a status change. done/skipped stamp completed_by (the provided display
 * name, falling back server-side to the token label) + completed_at; pending
 * clears both. Network failures throw (the caller reverts its optimistic
 * write); HTTP failures return an outcome.
 */
export async function updatePmTaskStatus(
  taskId: string,
  status: PmTaskStatus,
  completedBy: string | undefined,
  config: StaffConfig,
  fetchImpl: FetchLike = fetch,
): Promise<PmTaskUpdateOutcome> {
  const res = await fetchImpl(`${config.baseUrl}${BASE}/${encodeURIComponent(taskId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(completedBy ? { status, completedBy } : { status }),
  });
  if (res.ok) {
    return { ok: true, task: UpdateResponseSchema.parse(await res.json()).data };
  }
  return { ok: false, retry: isRetryableStatus(res.status), status: res.status };
}
