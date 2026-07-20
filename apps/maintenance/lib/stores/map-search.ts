import { create } from "zustand";

/**
 * The property map's unit search text. It lives in a store (not local screen
 * state) so the floating tab bar's search field can drive it on the map route,
 * exactly as it drives the work-order search on the list routes.
 */
interface MapSearchState {
  query: string;
  setQuery: (query: string) => void;
}

export const useMapSearch = create<MapSearchState>((set) => ({
  query: "",
  setQuery: (query) => set({ query }),
}));
