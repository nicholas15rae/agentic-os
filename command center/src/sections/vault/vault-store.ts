import { create } from "zustand";
import { cc, type Collection, type VaultResults } from "@/lib/cc-api";

/**
 * The Vault page's query, filters and results, shared by its Search and Results panels (they are
 * separate panels on the shared layout, so this can't be local state). Cleared when the page
 * closes, like the old page's local state.
 */
interface VaultSearchState {
  q: string;
  filters: Set<Collection>;
  res: VaultResults | null;
  busy: boolean;
  err: string | null;
  setQ: (q: string) => void;
  toggle: (c: Collection) => void;
  search: () => Promise<boolean>;
  clear: () => void;
}

/** Bumped by every search and clear: a reply that comes back after the page closed is dropped. */
let gen = 0;

const EMPTY = { q: "", filters: new Set<Collection>(), res: null, busy: false, err: null };

export const useVaultSearch = create<VaultSearchState>((set, get) => ({
  ...EMPTY,
  setQ: (q) => set({ q }),
  toggle: (c) => {
    const next = new Set(get().filters);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    set({ filters: next });
  },
  search: async () => {
    const { q, filters } = get();
    if (!q.trim()) return false;
    const my = ++gen;
    set({ busy: true, err: null });
    try {
      // Nic's own search: an unfiltered search still covers receipts, invoices and cheques.
      const res = await cc.search(q, [...filters], 20, { includeFinance: true });
      if (my !== gen) return false;
      set({ res });
      return true;
    } catch (e) {
      if (my === gen) set({ err: String(e) });
      return false;
    } finally {
      if (my === gen) set({ busy: false });
    }
  },
  clear: () => {
    gen++;
    set({ ...EMPTY, filters: new Set() });
  },
}));
