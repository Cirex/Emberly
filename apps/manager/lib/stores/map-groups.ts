import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { MapFilterGroup } from "@emberly/core";
import { defaultManagerMapGroups } from "@/components/map/groups-defaults";

/**
 * The map's leasing filter color groups — persisted per device, seeded with
 * the manager defaults (Vacant ready / Lease ends 30d / Eviction /
 * Balance > $800; see components/map/groups-defaults.ts). Order is priority:
 * the first VISIBLE matching group paints a unit. Evaluation lives in
 * @emberly/core (buildGroupPaint); this store only owns the definitions.
 *
 * Same shape as the maintenance app's store, minus its `enabled` master
 * switch — the manager expresses on/off through the lens store
 * (lib/stores/map-lens.ts) instead of a second boolean.
 */
interface MapGroupsState {
  groups: MapFilterGroup[];
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
      groups: defaultManagerMapGroups(),
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
      name: "emberly-manager-map-groups",
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
