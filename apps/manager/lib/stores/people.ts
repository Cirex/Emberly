import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { reportSyncFailed, reportSyncSucceeded } from "@/lib/analytics";
import {
  fetchPeopleIndex,
  fetchTenantProfile,
  type PeopleIndexEntry,
  type TenantProfile,
} from "@/lib/api/people";
import { registerSync } from "@/lib/sync-registry";
import type { StaffConfig } from "@/lib/stores/config";

/**
 * The People store: a persisted, PII-FREE directory index plus a session-only
 * cache of fetched profiles.
 *
 * WHY THE SPLIT MATTERS. The index (name, unit, phones, email, plates) is
 * cached on disk on purpose — that is what makes search instant and offline.
 * Profiles are NOT persisted: they carry the household, employment and, after
 * a reveal, birthdate and licence. Those live in memory for the length of the
 * session and are gone on relaunch, so a lost phone never yields a resident's
 * date of birth from the app's storage.
 *
 * REVEALS ARE PER-FIELD AND PER-TAP. `revealPii` refetches the profile with
 * `includePii` and records which field the manager asked for; the SERVER
 * writes an admin_audit_logs row for every one of those calls. `revealed[id]`
 * is what the UI consults to decide whether a field renders masked.
 */
interface PeopleState {
  /** The search index, cached on disk across launches. */
  index: PeopleIndexEntry[];
  loading: boolean;
  error?: string;
  /** Epoch ms of the last successful load/refresh; 0 = never this install. */
  refreshedAt: number;
  loadAll: (config: StaffConfig) => Promise<void>;
  /** Silent background sync — no spinner, no write when nothing changed. */
  refresh: (config: StaffConfig) => Promise<void>;

  /** Session-only profile cache, keyed by personLeaseId. Never persisted. */
  profiles: Record<string, TenantProfile>;
  /** personLeaseId currently being fetched, or null. */
  loadingProfile: string | null;
  profileError?: string;
  /** Per-person list of masked fields the manager has revealed this session. */
  revealed: Record<string, string[]>;
  /** Fetch (or return the cached) profile. Returns null on failure. */
  loadProfile: (config: StaffConfig, personLeaseId: string) => Promise<TenantProfile | null>;
  /**
   * Reveal one masked field: refetches with `includePii`, which the server
   * audits. Returns false when the fetch failed (the field stays masked).
   */
  revealPii: (config: StaffConfig, personLeaseId: string, field: string) => Promise<boolean>;
}

let refreshing = false;

export const usePeople = create<PeopleState>()(
  persist(
    (set, get) => ({
      index: [],
      loading: false,
      refreshedAt: 0,
      profiles: {},
      loadingProfile: null,
      revealed: {},

      loadAll: async (config) => {
        if (get().loading) return;
        // With a cache on disk the spinner is reserved for a true first run.
        set({ loading: get().index.length === 0, error: undefined });
        try {
          const index = await fetchPeopleIndex(config);
          set({ index, loading: false, refreshedAt: Date.now() });
          reportSyncSucceeded("people");
        } catch (err) {
          set({ loading: false, error: err instanceof Error ? err.message : "Failed to load people" });
          reportSyncFailed("people");
        }
      },

      refresh: async (config) => {
        if (refreshing) return;
        refreshing = true;
        try {
          const index = await fetchPeopleIndex(config);
          // A quiet 60s poll must not re-render the directory just to confirm
          // nothing moved.
          if (JSON.stringify(index) !== JSON.stringify(get().index)) set({ index });
          set({ refreshedAt: Date.now() });
          reportSyncSucceeded("people");
        } catch {
          // The cached index stands; the next tick retries.
          reportSyncFailed("people");
        } finally {
          refreshing = false;
        }
      },

      loadProfile: async (config, personLeaseId) => {
        const cached = get().profiles[personLeaseId];
        if (cached) return cached;
        set({ loadingProfile: personLeaseId, profileError: undefined });
        try {
          const profile = await fetchTenantProfile(config, personLeaseId);
          set((s) => ({
            profiles: { ...s.profiles, [personLeaseId]: profile },
            loadingProfile: s.loadingProfile === personLeaseId ? null : s.loadingProfile,
          }));
          return profile;
        } catch (err) {
          set((s) => ({
            loadingProfile: s.loadingProfile === personLeaseId ? null : s.loadingProfile,
            profileError: err instanceof Error ? err.message : "Failed to load profile",
          }));
          return null;
        }
      },

      revealPii: async (config, personLeaseId, field) => {
        try {
          const profile = await fetchTenantProfile(config, personLeaseId, {
            includePii: true,
            field,
          });
          set((s) => {
            const already = s.revealed[personLeaseId] ?? [];
            return {
              profiles: { ...s.profiles, [personLeaseId]: profile },
              revealed: {
                ...s.revealed,
                [personLeaseId]: already.includes(field) ? already : [...already, field],
              },
            };
          });
          return true;
        } catch (err) {
          set({ profileError: err instanceof Error ? err.message : "Failed to reveal" });
          return false;
        }
      },
    }),
    {
      name: "emberly-manager-people",
      storage: createJSONStorage(() => AsyncStorage),
      // ONLY the PII-free index survives restarts. Profiles and reveals are
      // deliberately session-only — see the module comment.
      partialize: (s) => ({ index: s.index, refreshedAt: s.refreshedAt }),
    },
  ),
);

// Self-register with the sync tick (see lib/sync-registry.ts): cold cache takes
// the loadAll spinner path, every later tick is a silent refresh.
registerSync("people", async (config) => {
  const s = usePeople.getState();
  if (s.index.length === 0) await s.loadAll(config);
  else await s.refresh(config);
});
