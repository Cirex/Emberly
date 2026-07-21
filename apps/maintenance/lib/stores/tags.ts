import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create } from "zustand";
import { reportSyncFailed, reportSyncSucceeded } from "@/lib/analytics";
import type { StaffConfig } from "@/lib/stores/config";

type ScannerConfig = StaffConfig;

/**
 * Shared, expiring unit tags. A server-backed layer (admins + guard iPads
 * read/write), keyed by unit number. Hydrate from disk, then follow the server
 * on every sync tick — expiration is enforced server-side, so a synced pull is
 * also how expired tags disappear here.
 */
export type ExpiryKind = "never" | "date" | "duration" | "move_out" | "status_change";

export interface UnitTag {
  id: string;
  unitNumber: string;
  label: string;
  colorHex: string;
  expiryKind: ExpiryKind;
  expiresAt: string | null;
  statusTrigger: string | null;
  createdByDisplayName: string | null;
}

const RemoteTagSchema = z.object({
  id: z.string(),
  unitNumber: z.string(),
  label: z.string(),
  colorHex: z.string(),
  expiryKind: z.enum(["never", "date", "duration", "move_out", "status_change"]),
  expiresAt: z.string().nullable(),
  statusTrigger: z.string().nullable(),
  createdByDisplayName: z.string().nullable(),
});
const ListSchema = z.object({ tags: z.array(RemoteTagSchema) });

const KEY = "emberly_unit_tags_v1";

/** Draft for a new tag — expiry inputs mirror the create API. */
export interface NewTag {
  label: string;
  colorHex: string;
  expiryKind: ExpiryKind;
  expiresOn?: string | null;
  durationDays?: number | null;
}

interface TagsState {
  byUnit: Record<string, UnitTag[]>;
  hydrated: boolean;
  syncing: boolean;
  hydrate: () => Promise<void>;
  tagsFor: (unitNumber: string) => UnitTag[];
  sync: (config: ScannerConfig) => Promise<void>;
  /** Create a tag on a unit. Returns null on failure (e.g. duplicate). */
  add: (unitNumber: string, draft: NewTag, config: ScannerConfig) => Promise<UnitTag | null>;
  remove: (unitNumber: string, tagId: string, config: ScannerConfig) => Promise<void>;
}

function groupByUnit(tags: UnitTag[]): Record<string, UnitTag[]> {
  const out: Record<string, UnitTag[]> = {};
  for (const t of tags) (out[t.unitNumber] ??= []).push(t);
  return out;
}

const EMPTY: UnitTag[] = [];

export const useTags = create<TagsState>((set, get) => ({
  byUnit: {},
  hydrated: false,
  syncing: false,

  hydrate: async () => {
    const raw = await AsyncStorage.getItem(KEY);
    set({ byUnit: raw ? JSON.parse(raw) : {}, hydrated: true });
  },

  tagsFor: (unitNumber) => get().byUnit[unitNumber] ?? EMPTY,

  sync: async (config) => {
    if (get().syncing) return;
    set({ syncing: true });
    try {
      const res = await fetch(`${config.baseUrl}/api/admin/unit-tags`, {
        headers: { Authorization: `Bearer ${config.token}` },
      });
      if (!res.ok) {
        // A reachable server that answers non-2xx is still a failed sync.
        reportSyncFailed("tags");
        return;
      }
      const byUnit = groupByUnit(ListSchema.parse(await res.json()).tags);
      if (JSON.stringify(byUnit) !== JSON.stringify(get().byUnit)) {
        set({ byUnit });
        void AsyncStorage.setItem(KEY, JSON.stringify(byUnit));
      }
      reportSyncSucceeded("tags");
    } catch {
      // Offline — the cached set stands until a tick succeeds.
      reportSyncFailed("tags");
    } finally {
      set({ syncing: false });
    }
  },

  add: async (unitNumber, draft, config) => {
    try {
      const res = await fetch(`${config.baseUrl}/api/admin/unit-tags`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify({ unitNumber, ...draft }),
      });
      if (!res.ok) return null;
      const tag = RemoteTagSchema.parse((await res.json()).tag);
      set((s) => {
        const next = { ...s.byUnit, [unitNumber]: [...(s.byUnit[unitNumber] ?? []), tag] };
        void AsyncStorage.setItem(KEY, JSON.stringify(next));
        return { byUnit: next };
      });
      return tag;
    } catch {
      return null;
    }
  },

  remove: async (unitNumber, tagId, config) => {
    // Optimistic — drop locally, then tell the server.
    set((s) => {
      const next = {
        ...s.byUnit,
        [unitNumber]: (s.byUnit[unitNumber] ?? []).filter((t) => t.id !== tagId),
      };
      void AsyncStorage.setItem(KEY, JSON.stringify(next));
      return { byUnit: next };
    });
    try {
      await fetch(`${config.baseUrl}/api/admin/unit-tags/${tagId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${config.token}` },
      });
    } catch {
      // The next sync restores it if the delete never landed.
    }
  },
}));

/** Human badge for a tag's expiration rule — matches the admin web wording. */
export function tagExpiryBadge(tag: UnitTag): string {
  switch (tag.expiryKind) {
    case "move_out":
      return "until move-out";
    case "status_change":
      return `while ${tag.statusTrigger ?? "status"}`;
    case "date":
    case "duration": {
      if (!tag.expiresAt) return "expiring";
      const days = Math.ceil((new Date(tag.expiresAt).getTime() - Date.now()) / 86_400_000);
      return days <= 1 ? "expires today" : `${days}d left`;
    }
    default:
      return "";
  }
}
