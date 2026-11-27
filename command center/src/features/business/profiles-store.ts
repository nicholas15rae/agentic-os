/**
 * The business profiles, loaded from / saved to the local gateway (shared by desktop and phone).
 * On the first load it runs the one-time import of the old single localStorage profile.
 *
 * Saves are whole-document PUTs guarded by the gateway's `rev`: a save based on a stale copy (the
 * phone saved meanwhile) gets 409, and this device's own unsaved edits are merged per profile / per
 * field over the fresh doc and saved once more (`mergeEdits`). Edits made while the gateway can't be
 * reached stay queued (in memory and in this device's localStorage) and are saved on the next
 * successful contact.
 */
import { create } from "zustand";
import { gateway } from "@/lib/gateway";
import { useSettings } from "@/stores/settings";
import { commissionFrom, DEFAULT_FINANCE, emptyProfile, importLegacy, mergeEdits, profileForArea, withDefaults, type BusinessProfile, type FinanceSettings, type ProfileId, type ProfilesDoc } from "./profiles";

const PATH = "/api/cc/business/profiles";
/** Unsaved edits survive a reload / app restart on this device until the gateway takes them. */
export const PENDING_KEY = "cc.business.profiles.pending";
const SAVE_DEBOUNCE_MS = 600;
export const RETRY_MS = 30_000;

interface ProfilesState {
  doc: ProfilesDoc;
  /** The last doc read from / saved to the gateway (with its rev): what `doc`'s edits are based on. */
  base: ProfilesDoc;
  /** Loaded from the gateway at least once (until then `doc` is defaults or queued edits). */
  loaded: boolean;
  saving: boolean;
  /** `doc` has edits the gateway doesn't have yet (queued while it's unreachable). */
  pending: boolean;
  error: string | null;
  /** Where the old single profile went, once (for a one-line notice). */
  importedTo: string | null;
  load: () => Promise<void>;
  /** Merge into one profile and save (debounced). */
  patch: (id: ProfileId, patch: Partial<BusinessProfile>) => void;
  /** Finance: add a new area (a profile with a label). */
  addArea: (id: string, label: string) => void;
  /** Finance-wide settings (per-km rate). */
  patchFinance: (patch: Partial<FinanceSettings>) => void;
}

interface Pending {
  base: ProfilesDoc;
  doc: ProfilesDoc;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
let flushing: Promise<void> | null = null;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const statusOf = (e: unknown): number | undefined => (e && typeof e === "object" && "status" in e && typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : undefined);
/** Worth retrying by itself: unreachable / timed out (no status) or a gateway-side failure. */
const transient = (e: unknown) => {
  const s = statusOf(e);
  return s === undefined || s >= 500;
};

function readPending(): Pending | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(PENDING_KEY) : null;
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Pending>;
    return p && typeof p === "object" && p.doc && p.base ? { base: withDefaults(p.base), doc: withDefaults(p.doc) } : null;
  } catch {
    return null;
  }
}

function writePending(p: Pending | null) {
  try {
    if (typeof localStorage === "undefined") return;
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    /* storage full / blocked: the edits stay queued in memory */
  }
}

async function fetchDoc(): Promise<ProfilesDoc> {
  const r = await gateway<{ value: ProfilesDoc | null; rev?: number }>(PATH);
  return withDefaults(r.value ? { ...r.value, rev: r.rev ?? r.value.rev ?? 0 } : { version: 1, legacyImported: false, profiles: {}, rev: r.rev ?? 0 });
}

async function putDoc(doc: ProfilesDoc): Promise<ProfilesDoc> {
  // Default finance settings aren't sent, so a gateway from before Finance areas still accepts the doc.
  const { finance, rev, ...rest } = doc;
  const value = finance && finance.kmRate !== DEFAULT_FINANCE.kmRate ? { ...rest, finance } : rest;
  const r = await gateway<{ value: ProfilesDoc; rev?: number }>(PATH, { method: "PUT", body: JSON.stringify({ value, rev: rev ?? 0 }) });
  return withDefaults({ ...r.value, rev: r.rev ?? r.value.rev ?? (rev ?? 0) + 1 });
}

/**
 * Save `mine` (edited on top of `base`). A 409 (another device saved since `base`) re-reads the
 * gateway, merges this device's edits over the fresh doc and retries once. Returns what's stored.
 */
export async function saveMerged(base: ProfilesDoc, mine: ProfilesDoc): Promise<ProfilesDoc> {
  try {
    return await putDoc({ ...mine, rev: base.rev ?? 0 });
  } catch (e) {
    if (statusOf(e) !== 409) throw e;
    const fresh = await fetchDoc();
    return await putDoc(mergeEdits(base, mine, fresh));
  }
}

const initial = readPending();

export const useProfiles = create<ProfilesState>()((set, get) => ({
  doc: initial?.doc ?? withDefaults(null),
  base: initial?.base ?? withDefaults(null),
  loaded: false,
  saving: false,
  pending: !!initial,
  error: null,
  importedTo: null,
  load: () => {
    inflight ??= (async (): Promise<boolean> => {
      try {
        if (flushing) await flushing; // never read while our own save is mid-air
        const fresh = await fetchDoc();
        const { doc: imported, changed, target } = importLegacy(fresh, useSettings.getState().business);
        // Edits queued here (offline, or typed during this read) go on top of the fresh doc.
        const s = get();
        const doc = s.pending ? mergeEdits(s.base, s.doc, imported) : imported;
        const pending = s.pending || changed;
        set({ doc, base: fresh, loaded: true, pending, error: null, ...(target ? { importedTo: target } : {}) });
        if (pending) writePending({ base: fresh, doc });
        return pending;
      } catch (e) {
        set({ error: message(e) });
        if (get().pending) scheduleRetry();
        return false;
      }
    })().then((needSave) => {
      inflight = null;
      if (needSave) void flush();
    });
    return inflight;
  },
  addArea: (id, label) => {
    if (get().doc.profiles[id]) return;
    get().patch(id, { ...emptyProfile(id), label });
  },
  patchFinance: (patch) => {
    const cur = get().doc;
    save({ ...cur, finance: { ...cur.finance!, ...patch } });
  },
  patch: (id, patch) => {
    const cur = get().doc;
    save({ ...cur, profiles: { ...cur.profiles, [id]: { ...(cur.profiles[id] ?? emptyProfile(id)), ...patch } } });
  },
}));

/** Set the doc now, queue it, save it to the gateway (debounced; after the first read). */
function save(doc: ProfilesDoc) {
  const { getState: get, setState: set } = useProfiles;
  set({ doc, pending: true });
  writePending({ base: get().base, doc });
  // Never overwrite the gateway's copy before reading it: the read merges these edits and saves them.
  if (!get().loaded) {
    if (!inflight) scheduleRetry();
    return;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, SAVE_DEBOUNCE_MS);
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    const s = useProfiles.getState();
    if (!s.loaded) void s.load();
    else if (s.pending) void flush();
  }, RETRY_MS);
}

/** Push the queued edits to the gateway (merging over a newer doc on 409). */
function flush(): Promise<void> {
  if (flushing) return flushing; // its own follow-up picks up edits made meanwhile
  if (inflight) return inflight; // the read in progress saves the queue when it lands
  const { getState: get, setState: set } = useProfiles;
  const s = get();
  if (!s.loaded || !s.pending) return Promise.resolve();
  const base = s.base;
  const mine = s.doc;
  set({ saving: true });
  flushing = (async () => {
    try {
      const saved = await saveMerged(base, mine);
      const now = get().doc;
      if (now === mine) {
        set({ doc: saved, base: saved, pending: false, saving: false, error: null });
        writePending(null);
      } else {
        // Edited while saving: those newer edits go on top of what was stored, saved next.
        const doc = mergeEdits(mine, now, saved);
        set({ doc, base: saved, saving: false, error: null });
        writePending({ base: saved, doc });
        if (!timer) timer = setTimeout(() => ((timer = null), void flush()), SAVE_DEBOUNCE_MS);
      }
    } catch (e) {
      set({ saving: false, error: message(e) });
      if (transient(e)) scheduleRetry();
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** Load the profiles if they aren't yet; true = they're loaded (false: the gateway couldn't be read). */
export async function ensureProfiles(): Promise<boolean> {
  if (!useProfiles.getState().loaded) await useProfiles.getState().load();
  return useProfiles.getState().loaded;
}

/** Tests: drop timers and in-memory state (localStorage is the test's own). */
export function resetProfilesForTests() {
  if (timer) clearTimeout(timer);
  if (retryTimer) clearTimeout(retryTimer);
  timer = retryTimer = null;
  inflight = flushing = null;
  const p = readPending();
  useProfiles.setState({ doc: p?.doc ?? withDefaults(null), base: p?.base ?? withDefaults(null), loaded: false, saving: false, pending: !!p, error: null, importedTo: null });
}

/** The profile an invoice of `area` prints with (default Contracting). Sync: whatever is loaded. */
export const profileFor = (area?: string | null) => profileForArea(useProfiles.getState().doc, area);

/** For Finance: the default commission % for a booking through `agencyId`, or null. */
export const defaultCommission = (agencyId: string, union: boolean): number | null => commissionFrom(useProfiles.getState().doc.profiles.acting?.agencies, agencyId, union);
