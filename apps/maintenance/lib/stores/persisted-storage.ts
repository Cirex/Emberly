import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PersistStorage, StorageValue } from "zustand/middleware";

/**
 * AsyncStorage for zustand's persist middleware, with the write skipped when
 * nothing it would write has changed.
 *
 * WHY THIS EXISTS. zustand persists on EVERY `set()` — the middleware wraps
 * setState and unconditionally calls `storage.setItem`, and `createJSONStorage`
 * stringifies inside it. Nothing compares the result to what is already on disk.
 * So a store whose only change was a freshness clock still serializes and writes
 * its entire persisted payload.
 *
 * On the work-order store that payload is 3.79 MB of the live mirror, and the
 * background sync's quiet tick — the one whose whole design goal is to cost
 * nothing when the server has no news — called `set({ refreshedAt })` every 15
 * seconds. Byte-identical, four times a minute, forever. The units store did the
 * same with 2.2 MB. That is the periodic stall.
 *
 * THE GATE is a shallow compare of the partialized state against the last thing
 * written. Stores update immutably (React depends on it), so an unchanged slice
 * keeps its reference and the compare is O(number of persisted keys) — no
 * serializing to find out that serializing was unnecessary. A store that mutated
 * state in place would be skipped here, but such a store would already fail to
 * re-render, so the invariant is one the app relies on regardless.
 */

const NOTHING_WRITTEN = Symbol("nothing-written");

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

export function persistedStorage<T>(): PersistStorage<T> {
  let lastWritten: unknown = NOTHING_WRITTEN;
  return {
    getItem: async (name) => {
      const raw = await AsyncStorage.getItem(name);
      if (raw === null) return null;
      const value = JSON.parse(raw) as StorageValue<T>;
      // Seed the gate with what is already on disk, so the write that follows
      // hydration — same values, fresh object — is recognised as a no-op.
      lastWritten = value.state;
      return value;
    },
    setItem: async (name, value) => {
      if (shallowEqual(lastWritten, value.state)) return;
      lastWritten = value.state;
      await AsyncStorage.setItem(name, JSON.stringify(value));
    },
    removeItem: async (name) => {
      // Forget the gate too: after a purge the next identical state MUST be
      // written back, or a sign-out would leave the store unpersisted.
      lastWritten = NOTHING_WRITTEN;
      await AsyncStorage.removeItem(name);
    },
  };
}
