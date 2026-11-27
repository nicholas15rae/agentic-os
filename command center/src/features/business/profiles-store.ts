/**
 * The business profiles, loaded from / saved to the local gateway (shared by desktop and phone).
 * On the first load it runs the one-time import of the old single localStorage profile.
 */
import { create } from "zustand";
import { gateway } from "@/lib/gateway";
import { useSettings } from "@/stores/settings";
import { commissionFrom, importLegacy, profileForArea, withDefaults, type BusinessProfile, type ProfileId, type ProfilesDoc } from "./profiles";

const PATH = "/api/cc/business/profiles";

interface ProfilesState {
  doc: ProfilesDoc;
  /** Loaded from the gateway at least once (until then `doc` is all defaults). */
  loaded: boolean;
  saving: boolean;
  error: string | null;
  /** Where the old single profile went, once (for a one-line notice). */
  importedTo: string | null;
  load: () => Promise<void>;
  /** Merge into one profile and save (debounced). */
  patch: (id: ProfileId, patch: Partial<BusinessProfile>) => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;

async function put(doc: ProfilesDoc): Promise<ProfilesDoc> {
  const r = await gateway<{ value: ProfilesDoc }>(PATH, { method: "PUT", body: JSON.stringify({ value: doc }) });
  return withDefaults(r.value);
}

export const useProfiles = create<ProfilesState>()((set, get) => ({
  doc: withDefaults(null),
  loaded: false,
  saving: false,
  error: null,
  importedTo: null,
  load: () => {
    inflight ??= (async () => {
      try {
        const r = await gateway<{ value: ProfilesDoc | null }>(PATH);
        const { doc, changed, target } = importLegacy(r.value, useSettings.getState().business);
        set({ doc, loaded: true, error: null, ...(target ? { importedTo: target } : {}) });
        if (changed) {
          const saved = await put(doc);
          if (get().doc === doc) set({ doc: saved }); // unless an edit landed meanwhile (its own save follows)
        }
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
  patch: (id, patch) => {
    const cur = get().doc;
    const doc: ProfilesDoc = { ...cur, profiles: { ...cur.profiles, [id]: { ...cur.profiles[id], ...patch } } };
    set({ doc });
    if (!get().loaded) return; // never overwrite the gateway's copy before reading it
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      set({ saving: true });
      try {
        await put(get().doc);
        set({ saving: false, error: null });
      } catch (e) {
        set({ saving: false, error: e instanceof Error ? e.message : String(e) });
      }
    }, 600);
  },
}));

/** The profile an invoice of `area` prints with (default Contracting). Sync: whatever is loaded. */
export const profileFor = (area?: string | null) => profileForArea(useProfiles.getState().doc, area);

/** For Finance: the default commission % for a booking through `agencyId`, or null. */
export const defaultCommission = (agencyId: string, union: boolean): number | null => commissionFrom(useProfiles.getState().doc.profiles.acting?.agencies, agencyId, union);
