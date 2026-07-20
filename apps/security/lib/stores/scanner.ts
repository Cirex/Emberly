import { create } from "zustand";
import { capture } from "@/lib/analytics";
import { type ScannerConfig, type VerifyResponse, verifyPass } from "@/lib/api/scanner";

/** Scanner state machine — mirrors iOS ScannerViewModel.State. */
export type ScannerPhase = "scanning" | "verifying" | "granted" | "denied" | "unable";

export interface RecentScan {
  id: string;
  name: string;
  ok: boolean;
  at: number;
}

interface ScannerState {
  phase: ScannerPhase;
  result?: VerifyResponse;
  errorMessage?: string;
  recent: RecentScan[];
  verify: (token: string, config: ScannerConfig) => Promise<void>;
  reset: () => void;
}

let seq = 0;

export const useScanner = create<ScannerState>((set, get) => ({
  phase: "scanning",
  recent: [],

  verify: async (token, config) => {
    // Ignore repeat frames while not actively scanning.
    if (get().phase !== "scanning") return;
    set({ phase: "verifying", errorMessage: undefined });

    try {
      const result = await verifyPass(token, config);
      const name = result.tenantName ?? (result.entryType === "guest" ? "Guest" : "Resident");
      // No PII: the outcome and the kind of pass, never the resident/guest name.
      capture("pass_scanned", {
        result: result.valid ? "granted" : "denied",
        entryType: result.entryType ?? null,
      });
      if (result.valid) {
        set((s) => ({
          phase: "granted",
          result,
          recent: [
            { id: `${Date.now()}-${seq++}`, name, ok: true, at: Date.now() },
            ...s.recent,
          ].slice(0, 8),
        }));
      } else {
        set((s) => ({
          phase: "denied",
          result,
          recent: [
            { id: `${Date.now()}-${seq++}`, name: name || "Denied", ok: false, at: Date.now() },
            ...s.recent,
          ].slice(0, 8),
        }));
      }
    } catch (err) {
      capture("pass_scanned", { result: "unable", entryType: null });
      set({
        phase: "unable",
        result: undefined,
        errorMessage: err instanceof Error ? err.message : "Network error",
      });
    }
  },

  reset: () => set({ phase: "scanning", result: undefined, errorMessage: undefined }),
}));
