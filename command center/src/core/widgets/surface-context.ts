import { createContext, useContext, useEffect } from "react";
import { create } from "zustand";
import { useLayout, type LayoutStore } from "./layout-store";

/**
 * Shared layout system: which surface's store the grid, its cells, the Look panel and the
 * windows read. The home page needs no provider (it is the default).
 */
export const SurfaceContext = createContext<LayoutStore>(useLayout);

/** The layout store of the surface being drawn. */
export const useSurface = (): LayoutStore => useContext(SurfaceContext);

/** The surface on screen (the top bar's Edit layout toggle acts on it). Home when no page claimed it. */
export const useActiveSurface = create<{ store: LayoutStore }>(() => ({ store: useLayout }));

/** A page's LayoutSurface claims the top bar while it is mounted. */
export function useClaimSurface(store: LayoutStore) {
  useEffect(() => {
    useActiveSurface.setState({ store });
    return () => {
      if (useActiveSurface.getState().store === store) {
        store.getState().setEditing(false);
        useActiveSurface.setState({ store: useLayout });
      }
    };
  }, [store]);
}
