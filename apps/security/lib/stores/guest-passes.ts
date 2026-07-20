import { create } from "zustand";
import {
  type AdminConfig,
  type GuestPass,
  type PassStatus,
  listGuestPasses,
  revokeGuestPass,
} from "@/lib/api/guest-passes";

interface GuestPassesState {
  status: PassStatus;
  search: string;
  passes: GuestPass[];
  total: number;
  loading: boolean;
  error?: string;
  setStatus: (s: PassStatus) => void;
  setSearch: (q: string) => void;
  load: (config: AdminConfig) => Promise<void>;
  revoke: (id: string, config: AdminConfig) => Promise<void>;
  find: (id: string) => GuestPass | undefined;
}

export const useGuestPasses = create<GuestPassesState>((set, get) => ({
  status: "active",
  search: "",
  passes: [],
  total: 0,
  loading: false,

  setStatus: (status) => set({ status }),
  setSearch: (search) => set({ search }),

  load: async (config) => {
    set({ loading: true, error: undefined });
    try {
      const { status, search } = get();
      const feed = await listGuestPasses({ status, search, page: 1, limit: 50 }, config);
      set({ passes: feed.passes, total: feed.pagination.total, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : "Failed to load" });
    }
  },

  revoke: async (id, config) => {
    await revokeGuestPass(id, config);
    // Optimistic: mark revoked locally; the feed reload reconciles.
    set((s) => ({ passes: s.passes.map((p) => (p.id === id ? { ...p, status: "revoked" } : p)) }));
    await get().load(config);
  },

  find: (id) => get().passes.find((p) => p.id === id),
}));
