import { create } from "zustand";
import { persist } from "zustand/middleware";
import { persistedStorage } from "@/lib/stores/persisted-storage";
import { defaultMapFilterGroups, type MapFilterGroup } from "@emberly/core";

/**
 * The map's filter color groups — persisted per device, seeded with the three
 * prebuilt groups (Delinquent / Lease ending 30d / Vacant). Order is priority:
 * the first visible matching group paints a unit. Evaluation lives in
 * @emberly/core (buildGroupPaint); this store only owns the definitions.
 */
interface MapGroupsState {
  groups: MapFilterGroup[];
  /** Master switch: paint the map by groups (replaces the single occupancy tint). */
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  add: (group: Omit<MapFilterGroup, "id">) => MapFilterGroup;
  update: (id: string, patch: Partial<Omit<MapFilterGroup, "id">>) => void;
  remove: (id: string) => void;
  toggleVisible: (id: string) => void;
  /** Move a group one slot up (-1) or down (+1) in priority order. */
  move: (id: string, delta: -1 | 1) => void;
}

let seq = 0;
function newId(): string {
  seq += 1;
  return `group-${Date.now().toString(36)}-${seq}`;
}

export const useMapGroups = create<MapGroupsState>()(
  persist(
    (set, get) => ({
      groups: defaultMapFilterGroups(),
      enabled: false,
      setEnabled: (enabled) => set({ enabled }),
      add: (group) => {
        const created: MapFilterGroup = { ...group, id: newId() };
        set((s) => ({ groups: [...s.groups, created] }));
        return created;
      },
      update: (id, patch) =>
        set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) })),
      remove: (id) => set((s) => ({ groups: s.groups.filter((g) => g.id !== id) })),
      toggleVisible: (id) =>
        set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, visible: !g.visible } : g)) })),
      move: (id, delta) => {
        const groups = [...get().groups];
        const i = groups.findIndex((g) => g.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= groups.length) return;
        [groups[i], groups[j]] = [groups[j], groups[i]];
        set({ groups });
      },
    }),
    {
      name: "emberly-maintenance-map-groups",
      storage: persistedStorage(),
    },
  ),
);
