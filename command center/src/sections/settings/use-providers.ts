import { create } from "zustand";
import { cmd, isTauri, type AgentVoicePatch, type OsConfig, type PolicyPatch, type ProviderPatch, type ProvidersView } from "@/lib/platform";
import { gateway } from "@/lib/gateway";
import { isAndroidApp } from "@/stores/settings";

/** Android app: Settings show the DESKTOP's config (the phone's own copy points at 127.0.0.1 and has
 * no keys). Read-only, secrets kept out (keys: only whether the PC has one). Edits go on the desktop. */
export const desktopConfig = () => gateway<{ providers: ProvidersView; os: OsConfig | null }>("/api/os/desktop-config");
export const PHONE_READ_ONLY = "Read-only on the phone: these are the desktop's settings. Change them in the desktop app.";
const phoneReadOnly = (): Promise<never> => Promise.reject(new Error(PHONE_READ_ONLY));

/** providers.json, as the Settings dropdowns see and edit it (desktop only). */
interface ProvidersState {
  view: ProvidersView | null;
  error: string | null;
  saving: boolean;
  load: () => Promise<void>;
  patch: (p: ProviderPatch) => Promise<void>;
  policy: (p: PolicyPatch) => Promise<void>;
  /** Part 3: edit one agent's voice-roster row ("tony" accepted as an alias of "general"). */
  agentVoice: (role: string, p: AgentVoicePatch) => Promise<void>;
  /** The roster's master "All Tony" switch. */
  allTony: (on: boolean) => Promise<void>;
  apply: (v: Promise<ProvidersView>) => Promise<void>;
}

export const useProviders = create<ProvidersState>((set, get) => ({
  view: null,
  error: null,
  saving: false,
  load: async () => {
    if (!isTauri()) return;
    try {
      set({ view: isAndroidApp() ? (await desktopConfig()).providers : await cmd("providers_list"), error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },
  apply: async (p) => {
    set({ saving: true });
    try {
      set({ view: await p, error: null });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ saving: false });
    }
  },
  patch: (patch) => get().apply(isAndroidApp() ? phoneReadOnly() : cmd("providers_update", { patch })),
  policy: (patch) => get().apply(isAndroidApp() ? phoneReadOnly() : cmd("policy_update", { patch })),
  agentVoice: (role, patch) => get().apply(isAndroidApp() ? phoneReadOnly() : cmd("agent_voice_update", { role, patch })),
  allTony: (on) => get().apply(isAndroidApp() ? phoneReadOnly() : cmd("agent_voices_all_tony", { on })),
}));

const modelCache = new Map<string, { at: number; models: string[] }>();

/** Models a provider offers (cached 30 s). Errors surface as an empty list + message. */
export async function modelsFor(id: string, force = false): Promise<{ models: string[]; error?: string }> {
  const hit = modelCache.get(id);
  if (!force && hit && Date.now() - hit.at < 30_000) return { models: hit.models };
  // The phone can't list the PC's models (its Rust probes would hit 127.0.0.1 = the phone).
  if (isAndroidApp()) return { models: [], error: "Model lists are on the desktop" };
  try {
    const models = await cmd("provider_models", { id });
    modelCache.set(id, { at: Date.now(), models });
    return { models };
  } catch (e) {
    return { models: [], error: String(e) };
  }
}
