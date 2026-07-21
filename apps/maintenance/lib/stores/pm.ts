import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { capture } from "@/lib/analytics";
import {
  listPmTemplateRounds,
  updatePmTaskStatus,
  type PmTask,
  type PmTaskStatus,
  type PmTemplateRound,
} from "@/lib/api/pm-tasks";
import i18n from "@/lib/i18n";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * The current preventive-maintenance round, cached on device — active
 * templates with their per-unit tasks (lib/api/pm-tasks.ts). Follows the
 * work-orders store's shape: persisted snapshot, spinner only on a true first
 * load, and a silent `refresh` that skips the state write when the server has
 * nothing new (the sync tick calls it every minute).
 *
 * `checkOff` is optimistic: the task flips locally first, then the POST
 * confirms it; on failure the previous task state is restored and `error`
 * carries a translated message for the board to surface.
 */

interface PmState {
  templates: PmTemplateRound[];
  dataVersion: number;
  /** Wall-clock ms of the last completed refresh (0 = never this session). */
  refreshedAt: number;
  loading: boolean;
  error?: string;
  loadAll: (config: StaffConfig) => Promise<void>;
  /** Silent background sync: skips the state write when nothing changed. */
  refresh: (config: StaffConfig) => Promise<void>;
  /**
   * Optimistically set a task's status and POST it. `completedBy` is the
   * signed-in tech's display name, stamped on done/skipped.
   */
  checkOff: (
    taskId: string,
    status: PmTaskStatus,
    config: StaffConfig,
    completedBy: string,
  ) => Promise<boolean>;
  clearError: () => void;
}

/** Immutably replace one task across the template groups. */
function withTask(
  templates: PmTemplateRound[],
  taskId: string,
  patch: (task: PmTask) => PmTask,
): PmTemplateRound[] {
  return templates.map((template) =>
    template.tasks.some((task) => task.id === taskId)
      ? { ...template, tasks: template.tasks.map((task) => (task.id === taskId ? patch(task) : task)) }
      : template,
  );
}

function findTask(
  templates: PmTemplateRound[],
  taskId: string,
): { template: PmTemplateRound; task: PmTask } | null {
  for (const template of templates) {
    const task = template.tasks.find((candidate) => candidate.id === taskId);
    if (task) return { template, task };
  }
  return null;
}

let refreshing = false;

export const usePm = create<PmState>()(
  persist(
    (set, get) => ({
      templates: [],
      dataVersion: 0,
      refreshedAt: 0,
      loading: false,

      loadAll: async (config) => {
        if (get().loading) return;
        // With a cache on disk the spinner is reserved for a true first run.
        set({ loading: get().templates.length === 0, error: undefined });
        try {
          const templates = await listPmTemplateRounds(config);
          set((s) => ({
            templates,
            dataVersion: s.dataVersion + 1,
            loading: false,
            refreshedAt: Date.now(),
          }));
        } catch (err) {
          set({
            loading: false,
            error: err instanceof Error ? err.message : i18n.t("preventive.loadFailed"),
          });
        }
      },

      refresh: async (config) => {
        if (refreshing) return;
        refreshing = true;
        try {
          const templates = await listPmTemplateRounds(config);
          // The state only moves when the data did — a quiet 60s poll must not
          // re-render the board just to confirm nothing happened.
          if (JSON.stringify(templates) !== JSON.stringify(get().templates)) {
            set((s) => ({ templates, dataVersion: s.dataVersion + 1, refreshedAt: Date.now() }));
          } else {
            set({ refreshedAt: Date.now() });
          }
        } catch {
          // Background sync failing is not an error state the UI should enter —
          // the cached round stands, and the next tick retries.
        } finally {
          refreshing = false;
        }
      },

      checkOff: async (taskId, status, config, completedBy) => {
        const found = findTask(get().templates, taskId);
        if (!found) return false;
        const previous = found.task;

        // Optimistic flip; the POST's response is authoritative afterwards.
        set((s) => ({
          error: undefined,
          templates: withTask(s.templates, taskId, (task) => ({
            ...task,
            status,
            completedBy: status === "pending" ? "" : completedBy,
            completedAt: status === "pending" ? null : new Date().toISOString(),
          })),
          dataVersion: s.dataVersion + 1,
        }));

        if (status !== "pending") {
          // No PII: machine cadence/category/status only.
          capture("pm_task_completed", {
            cadence: found.template.cadence,
            category: found.template.category,
            status,
          });
        }

        const revert = () => {
          set((s) => ({
            templates: withTask(s.templates, taskId, () => previous),
            dataVersion: s.dataVersion + 1,
            error: i18n.t("preventive.updateFailed"),
          }));
        };

        try {
          const outcome = await updatePmTaskStatus(taskId, status, completedBy, config);
          if (!outcome.ok) {
            revert();
            return false;
          }
          // Absorb the server's stamp (authoritative time + attribution).
          set((s) => ({
            templates: withTask(s.templates, taskId, (task) => ({
              ...task,
              status: outcome.task.status,
              completedBy: outcome.task.completedBy,
              completedAt: outcome.task.completedAt,
            })),
            dataVersion: s.dataVersion + 1,
          }));
          return true;
        } catch {
          revert();
          return false;
        }
      },

      clearError: () => set({ error: undefined }),
    }),
    {
      name: "emberly-maintenance-pm",
      storage: createJSONStorage(() => AsyncStorage),
      // Only the data survives restarts; dataVersion only needs to be
      // monotonic per session (mirrors the work-orders store).
      partialize: (s) => ({ templates: s.templates, dataVersion: s.dataVersion }),
    },
  ),
);
