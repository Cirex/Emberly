import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { reportSyncFailed, reportSyncSucceeded } from "@/lib/analytics";
import {
  createRenewalOffer,
  fetchRenewalOffers,
  resolveRenewalOffer,
  type RenewalOffer,
  type RenewalOfferInput,
  type RenewalResolutionStatus,
} from "@/lib/api/renewals";
import type { StaffConfig } from "@/lib/stores/config";
import { registerSync } from "@/lib/sync-registry";

/**
 * The renewal-offer mirror: every live offer, persisted so a relaunch opens
 * on yesterday's board while the sync tick refreshes behind it. Board math
 * (bands, metrics, comps, timeline) lives in lib/derived/renewals-view.ts —
 * this store only owns fetch/cache/mutate, with the same optimistic
 * write-then-revert shape as the delinquency store.
 */
interface RenewalsState {
  offers: RenewalOffer[];
  loading: boolean;
  error?: string;
  /** Epoch ms of the last successful refresh; 0 = never this install. */
  refreshedAt: number;
  load: (config: StaffConfig) => Promise<void>;
  refresh: (config: StaffConfig) => Promise<void>;
  /**
   * Optimistic send: the offer appears locally at once (status "sent"), the
   * POST runs behind it, and the server row replaces the local one on
   * success. On failure the local row is reverted and false returns so the
   * sheet can stay open with the draft intact.
   */
  sendOffer: (config: StaffConfig, input: RenewalOfferInput) => Promise<boolean>;
  /**
   * Optimistic resolve: the offer's status/respondedAt flip locally, the
   * PATCH runs behind it, and the server row replaces the local one. On
   * failure the previous row is restored and false returns.
   */
  resolveOffer: (
    config: StaffConfig,
    id: string,
    status: RenewalResolutionStatus,
  ) => Promise<boolean>;
}

let refreshing = false;
let localSeq = 0;

export const useRenewals = create<RenewalsState>()(
  persist(
    (set, get) => ({
      offers: [],
      loading: false,
      refreshedAt: 0,

      load: async (config) => {
        if (get().loading) return;
        // Spinner only on a truly cold cache; cached rows stay up otherwise.
        set({ loading: get().offers.length === 0, error: undefined });
        try {
          const offers = await fetchRenewalOffers(config);
          set({ offers, loading: false, refreshedAt: Date.now() });
          reportSyncSucceeded("renewals");
        } catch (err) {
          set({ loading: false, error: err instanceof Error ? err.message : "Failed to load" });
          reportSyncFailed("renewals");
        }
      },

      refresh: async (config) => {
        if (refreshing) return;
        refreshing = true;
        try {
          const offers = await fetchRenewalOffers(config);
          // Quiet tick: only write (and re-render) when the server moved.
          if (JSON.stringify(offers) !== JSON.stringify(get().offers)) set({ offers });
          set({ refreshedAt: Date.now() });
          reportSyncSucceeded("renewals");
        } catch {
          // Cached board stands; the next tick retries.
          reportSyncFailed("renewals");
        } finally {
          refreshing = false;
        }
      },

      sendOffer: async (config, input) => {
        const localId = `local-${Date.now()}-${localSeq++}`;
        const optimistic: RenewalOffer = {
          id: localId,
          resmanLeaseId: input.resmanLeaseId,
          resmanUnitId: input.resmanUnitId ?? "",
          unitNumber: input.unitNumber ?? "",
          priorRent: input.priorRent ?? null,
          proposedRent: input.proposedRent,
          termMonths: input.termMonths ?? null,
          isMonthToMonth: input.isMonthToMonth ?? false,
          status: "sent",
          sentAt: new Date().toISOString(),
          respondedAt: null,
          note: input.note ?? "",
          createdBy: "",
          createdAt: new Date().toISOString(),
        };
        set({ offers: [optimistic, ...get().offers] });
        try {
          const stored = await createRenewalOffer(config, input);
          set({ offers: get().offers.map((o) => (o.id === localId ? stored : o)) });
          return true;
        } catch {
          set({ offers: get().offers.filter((o) => o.id !== localId) });
          return false;
        }
      },

      resolveOffer: async (config, id, status) => {
        const before = get().offers;
        const target = before.find((o) => o.id === id);
        if (!target) return false;
        const optimistic: RenewalOffer = {
          ...target,
          status,
          respondedAt: new Date().toISOString(),
        };
        set({ offers: before.map((o) => (o.id === id ? optimistic : o)) });
        try {
          const stored = await resolveRenewalOffer(config, id, status);
          set({ offers: get().offers.map((o) => (o.id === id ? stored : o)) });
          return true;
        } catch {
          set({ offers: get().offers.map((o) => (o.id === id ? target : o)) });
          return false;
        }
      },
    }),
    {
      name: "emberly-manager-renewals",
      storage: createJSONStorage(() => AsyncStorage),
      // Only data survives restarts; flags are per-session.
      partialize: (s) => ({ offers: s.offers, refreshedAt: s.refreshedAt }),
    },
  ),
);

// Self-register with the sync tick (lib/sync-registry.ts): cold cache takes
// the spinner path, every later tick is a silent refresh.
registerSync("renewals", async (config) => {
  const s = useRenewals.getState();
  if (s.offers.length === 0 && s.refreshedAt === 0) await s.load(config);
  else await s.refresh(config);
});
