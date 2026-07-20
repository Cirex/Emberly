import { create } from "zustand";

/**
 * One-shot "View on Map" handoff: the tenant screen requests a unit, the map
 * screen consumes it on arrival — selects the unit (tooltip + highlight) and
 * flies the camera to it.
 */
interface MapJumpState {
  unitNumber?: string;
  /** Bumps per request so repeated jumps to the same unit still fire. */
  seq: number;
  request: (unitNumber: string) => void;
  consume: () => void;
}

export const useMapJump = create<MapJumpState>((set, get) => ({
  unitNumber: undefined,
  seq: 0,
  request: (unitNumber) => set({ unitNumber, seq: get().seq + 1 }),
  consume: () => set({ unitNumber: undefined }),
}));
