/**
 * The Finance area switcher + filters (area, agent, month, year), shared by every Finance tab,
 * and the area list from the business profiles.
 */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { useProfiles } from "@/features/business/profiles-store";
import { ALL_FILTER, areaLabel, listAreas, type FinanceFilter } from "./areas";

interface FilterState {
  filter: FinanceFilter;
  set: (patch: Partial<FinanceFilter>) => void;
  reset: () => void;
}

export const useFinanceFilter = create<FilterState>()((set) => ({
  filter: ALL_FILTER,
  set: (patch) => set((s) => ({ filter: { ...s.filter, ...patch } })),
  reset: () => set({ filter: ALL_FILTER }),
}));

/** The areas (built-ins + yours) and a label lookup; loads the profiles once. */
export function useAreas() {
  const doc = useProfiles((s) => s.doc);
  const loaded = useProfiles((s) => s.loaded);
  useEffect(() => {
    if (!useProfiles.getState().loaded) void useProfiles.getState().load();
  }, []);
  return useMemo(() => ({ areas: listAreas(doc), label: (id: string | undefined | null) => areaLabel(doc, id), doc, loaded }), [doc, loaded]);
}
