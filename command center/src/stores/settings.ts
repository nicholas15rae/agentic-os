import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_ACTIVATION_DB, DEFAULT_BARGE_MARGIN_DB, migrateSensitivity } from "@/features/voice/vad-gate";

export type WeatherMode = "auto" | "clear" | "rain" | "snow" | "autumn" | "midnight" | "fog";

/** Top-bar clock: 12-hour (default, decision 29) or 24-hour. */
export type HourCycle = "h12" | "h23";

/** Weather particle density: a multiplier on the particle counts (features/weather/weather.contract.ts EFFECT_MULT). */
export type EffectsIntensity = "low" | "normal" | "high";

/** Brainstorm Listen Mode dictation profile — how long a pause ends a thought, and the hard cap per utterance. */
export type ListenProfile = "snappy" | "relaxed" | "continuous";

/** System Map detail level: Streamlined = status colours and plain words; X-Ray adds ports, paths, IPC and per-hop ms. */
export type SystemMapMode = "streamlined" | "xray";

/** Where Tony's voice comes out (Phase 2): see `features/voice/audio-route.ts`. */
export type AudioRoute = "auto" | "headset" | "speakers";

/** Lowering Spotify while you talk to Tony (P4): see `features/voice/media-duck.ts`.
 * `reductionPct`: BY how much (0–50 %, default 15 → it plays at 85 %), never TO a level.
 * `restoreMs`: how soon it comes back after a line that wasn't for Tony (noise / room talk).
 * `onWakeListen`: also duck for speech heard by a passive hands-free wake listen or a follow-up listen.
 * `webApiFallback`: when no local Spotify session exists but Spotify plays on this PC, one Web API
 * volume change instead (no fade). Spotify only — there is deliberately no "all apps" scope. */
export interface MediaDuckSettings {
  enabled: boolean;
  reductionPct: number;
  restoreMs: number;
  onWakeListen: boolean;
  webApiFallback: boolean;
}

export const MEDIA_DUCK_DEFAULTS: MediaDuckSettings = { enabled: true, reductionPct: 15, restoreMs: 800, onWakeListen: true, webApiFallback: true };

export interface SettingsState {
  /** Agentic OS FastAPI backend. On mobile, use the desktop's NetBird IP. */
  gatewayUrl: string;
  /** Voice waveform colour ramp (left → right). Defaults follow the Stitch spectrum. */
  waveColors: [string, string, string];
  waveThickness: number;
  wallpaperIntervalSec: number;
  wallpaperShuffle: boolean;
  /** Rotate only through wallpapers tagged for the current weather + time of day. */
  wallpaperSync: boolean;
  /** Seconds a mutating action waits for yes/no before cancelling itself. */
  confirmTimeoutSec: number;
  /** "auto" = follow live weather (v8 resets a saved manual pick to "auto" once). */
  weatherMode: WeatherMode;
  /** Weather particles: off draws nothing (like reduced motion); intensity scales the counts. Reduced motion / PHONE_LITE still win. */
  effects: { enabled: boolean; intensity: EffectsIntensity };
  /** Top-bar clock (shell/TopBarClock): 12/24 h, and whether the date and the temperature show when there is room. */
  clock: { hourCycle: HourCycle; showDate: boolean; showTemp: boolean };
  /** Null = ask the browser for geolocation. */
  weatherLocation: { lat: number; lon: number; label: string } | null;
  identity: { callsign: string; subtitle: string };
  mantra: { lines: [string, string, string]; quote: [string, string, string] };
  /** Microphone deviceId (empty = system default). */
  micDeviceId: string;
  /** Printed on invoices. Stays on this device + the local gateway. */
  business: { name: string; address: string; email: string; phone: string; hstNumber: string; province: string; hstRate: number; currency: string };
  trading: {
    symbol: string;
    tvSymbol: string;
    interval: string;
    range: string;
    showPoc: boolean;
    showZones: boolean;
    showValueArea: boolean;
    /** Quick-switch tickers (Yahoo format). Optional: older persisted settings lack it. */
    watchlist?: string[];
    /** Top chart feed. "ibkr" = lightweight chart fed by IBKR bars (bridge must be connected). */
    chartSource?: "tradingview" | "ibkr";
  };
  /** `listenProfile` picks how patient Brainstorm Listen Mode is before it ends a thought (see capture.ts LISTEN_PROFILES). */
  brainstorm: { autoOrganizeEvery: number; listenProfile: ListenProfile };
  /** The OS's name ("Tony"). Mirrored from Rust os.json; drives headers, badges, wake words. */
  osName: string;
  wakeWords: string[];
  /** Hands-free: keep listening and act only on lines that start with a wake word. */
  wakeMode: boolean;
  /** Hands-free: only act on lines that start with a wake word (off = act on any speech). */
  wakeRequire: boolean;
  /** Ultra-glass panel opacity, 0–100 %. 0–5 % = crystal-clear floating HUD. */
  glassOpacity: number;
  /**
   * Pause ambient motion (wallpaper drift, weather, pulses, spinners, System Map drift) while the
   * window is unfocused or untouched for a minute, so the WebView2 GPU process stops sharing the
   * card with STT and the LLM (lib/motion.ts). Off = always animate while visible.
   */
  calmWhenIdle: boolean;
  /**
   * Phone only: bearer token for the gateway when the desktop's network lock is on.
   * Deliberately excluded from persistence (see `partialize` below) — a secret has no
   * business sitting in plaintext `localStorage`. Re-enter it each session.
   */
  gatewayToken: string;
  /**
   * Voice detection (v7, Phase 2 Part B): `activationDb` is the absolute speech gate in dBFS
   * (-70..-10; on desktop it mirrors os.json `voice.activationDb`), `bargeMarginDb` the extra a
   * barge-in over Tony needs, then the pause that ends an utterance and the hard cap.
   * `partialMs`: live captions while you speak, one every this many ms of speech (300-3000; 0 =
   * off, which also turns the phone's streamed STT off). Only on a GPU STT (features/voice/stt-partials.ts),
   * and only for listens that ask for captions (Tony's; not Brainstorm / System Map dictation).
   * Settings → Activation threshold → Live captions.
   */
  vad: { activationDb: number; bargeMarginDb: number; endSilenceMs: number; maxUtteranceMs: number; partialMs?: number };
  /**
   * Conversation: reopen the mic after Tony answers; let you talk over him.
   * `bargeEndSilenceMs`: end-of-speech pause for a listen opened over Tony (Phase 2 reflexes).
   * `audioRoute`: headset vs open speakers ("auto" reads the default output device's name).
   * `mediaDuck`: Spotify (on this PC) fades down BY `reductionPct`% while you talk to Tony (v6; was `spotifyDuck`).
   */
  conversation: { followUp: boolean; followUpSecs: number; bargeIn: boolean; bargeEndSilenceMs: number; audioRoute: AudioRoute; mediaDuck: MediaDuckSettings };
  /** Voice routing: `announcerHandoff` = Tony introduces a delegated agent, which then speaks its own answer in its own voice. */
  routing: {
    announcerHandoff: boolean;
    /** Thought-to-Product Phase 5 "Vocal Handoffs": a 3-beat spoken exchange when Tony delegates (off = routing chip only). */
    vocalHandoffs: boolean;
  };
  /** Alarms & reminders: `osFallback` = also register a Windows alarm that rings even when the app is closed. */
  reminders: { osFallback: boolean };
  /**
   * Chat: `showAgentConversation` shows the Agent Conversation cards (the full Tony ↔ agents
   * record of each build / delegation, from Rust's transcripts.db). Visual only — independent
   * of the spoken Agent Chatter (`routing.vocalHandoffs`) and the narrator.
   */
  chat: { showAgentConversation: boolean };
  /** System Map: Streamlined OS (default) or Dev X-Ray. */
  systemMapMode: SystemMapMode;
  /** System Map routing flowchart strip: expanded / collapsed; null = expand only on tall screens (≥ 900 px). */
  systemMapFlowOpen: boolean | null;
  set: (patch: Partial<Omit<SettingsState, "set">>) => void;
}

/**
 * When the PWA is served by the gateway itself (phone → http(s)://<desktop>:8080/cc/),
 * the gateway is simply this origin. In Tauri / Vite dev it's the local server.
 */
const defaultGateway = (): string => {
  if (typeof location !== "undefined" && location.pathname.startsWith("/cc")) return location.origin;
  if (isAndroidApp()) return PHONE_GATEWAY;
  return "http://127.0.0.1:8080";
};

/**
 * The Android (Tauri) build: 127.0.0.1 is the phone itself there, so it talks to the PC's gateway
 * over NetBird HTTPS (8443; the phone trusts the Agentic OS Local CA). Override with
 * VITE_PHONE_GATEWAY_URL at build time.
 */
const PHONE_GATEWAY: string = import.meta.env.VITE_PHONE_GATEWAY_URL || "https://100.84.91.149:8443";
const LOOPBACK_GATEWAY = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/;
export function isAndroidApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

/**
 * The desktop engine: Tauri on the PC, where Rust probes the local services (loopback) and can
 * start the gateway. The Android app is Tauri too, but its Rust side runs on the phone, so for
 * gateway health it behaves like the PWA (probe `gatewayUrl` with the token over NetBird).
 */
export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && !isAndroidApp();
}

/** The full default state (everything but the `set` action) — also the fallback side of `deepMergeDefaults`. */
const defaults: Omit<SettingsState, "set"> = {
  gatewayUrl: defaultGateway(),
  micDeviceId: "",
  business: { name: "", address: "", email: "", phone: "", hstNumber: "", province: "ON", hstRate: 13, currency: "CAD" },
  trading: {
    symbol: "SPY",
    tvSymbol: "AMEX:SPY",
    interval: "5m",
    range: "5d",
    showPoc: true,
    showZones: true,
    showValueArea: true,
    watchlist: ["SPY", "QQQ", "IWM", "GLD", "SLV", "USO", "UNG", "DBC"],
    chartSource: "tradingview",
  },
  brainstorm: { autoOrganizeEvery: 6, listenProfile: "relaxed" },
  osName: "Tony",
  wakeWords: ["hey tony", "yo tony", "tony"],
  wakeMode: false,
  wakeRequire: true,
  glassOpacity: 8,
  calmWhenIdle: true,
  gatewayToken: "",
  vad: { activationDb: DEFAULT_ACTIVATION_DB, bargeMarginDb: DEFAULT_BARGE_MARGIN_DB, endSilenceMs: 700, maxUtteranceMs: 15000, partialMs: 0 },
  conversation: { followUp: true, followUpSecs: 6, bargeIn: true, bargeEndSilenceMs: 500, audioRoute: "auto", mediaDuck: { ...MEDIA_DUCK_DEFAULTS } },
  routing: { announcerHandoff: true, vocalHandoffs: false },
  reminders: { osFallback: true },
  chat: { showAgentConversation: true },
  systemMapMode: "streamlined",
  systemMapFlowOpen: null,
  waveColors: ["#00F0FF", "#A855F7", "#FF6B4A"],
  waveThickness: 3,
  wallpaperIntervalSec: 45,
  wallpaperShuffle: false,
  wallpaperSync: true,
  confirmTimeoutSec: 30,
  weatherMode: "auto",
  effects: { enabled: true, intensity: "normal" },
  clock: { hourCycle: "h12", showDate: true, showTemp: true },
  weatherLocation: null,
  identity: { callsign: "E46 // GABAGOUL", subtitle: "TONY ACTIVE" },
  mantra: {
    lines: ["FOCUS", "DISCIPLINE", "CONSISTENCY"],
    quote: ["Be patient.", "Progress takes time,", "but it changes everything."],
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Every object key optional, recursively (arrays and primitives are left as-is — a persisted value for one of those either is there or isn't). */
export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/**
 * Recursively fills any key missing from `partial` (at any depth) with the matching value from
 * `full`, instead of zustand persist's default shallow merge — which replaces a whole nested
 * object (e.g. `brainstorm`, `vad`) wholesale and drops fields a prior app version never saved.
 * Arrays and primitives in `partial` win as-is when present; `full`'s shape always wins for keys
 * `partial` doesn't have. Exported so other config additions (new nested `SettingsState` fields
 * from later work) get the same backfill without each one re-implementing it.
 */
export function deepMergeDefaults<T>(partial: DeepPartial<T> | null | undefined, full: T): T {
  if (!isPlainObject(partial) || !isPlainObject(full)) return partial == null ? full : (partial as T);
  const out: Record<string, unknown> = { ...full, ...partial };
  for (const key of Object.keys(full)) {
    const f = (full as Record<string, unknown>)[key];
    const p = (partial as Record<string, unknown>)[key];
    if (isPlainObject(f)) out[key] = deepMergeDefaults(p as DeepPartial<typeof f> | null | undefined, f);
    else if (p === undefined) out[key] = f;
  }
  return out as T;
}

/**
 * Persisted-settings migration (exported for tests). v8: see below. v7: see below. v6 (P4): `conversation.spotifyDuck{level}` —
 * an ABSOLUTE "duck TO level%" — becomes `conversation.mediaDuck{reductionPct}`, "duck BY %".
 * `enabled` and `onWakeListen` carry over; `reductionPct` is forced to 15 and the old `level` /
 * `restoreMs` (tuned for the old deep duck) are dropped, so "15" can never be reread as a new meaning.
 */
export function migrateSettings(persisted: unknown, from: number): SettingsState {
  const s = (persisted ?? {}) as Partial<SettingsState> & { conversation?: Record<string, unknown> };
  // v4: the OS is called Tony now — retire the old default subtitle.
  if (from < 4 && s?.identity?.subtitle === "JARVIS ACTIVE") s.identity = { ...s.identity, subtitle: "TONY ACTIVE" };
  if (from < 6 && isPlainObject(s.conversation)) {
    const { spotifyDuck: old, ...conversation } = s.conversation;
    if (isPlainObject(old)) {
      const mediaDuck: MediaDuckSettings = { ...MEDIA_DUCK_DEFAULTS };
      if (typeof old.enabled === "boolean") mediaDuck.enabled = old.enabled;
      if (typeof old.onWakeListen === "boolean") mediaDuck.onWakeListen = old.onWakeListen;
      s.conversation = { ...conversation, mediaDuck };
    } else s.conversation = conversation;
  }
  // v7 (Phase 2 Part B): the 0–100 sensitivity becomes an absolute dBFS gate (60 → -44 dB).
  // `sensitivity` is dropped so it can never be reread; everything else (wakeMode…) is kept.
  if (from < 7) {
    const vad = isPlainObject(s.vad) ? (s.vad as unknown as Record<string, unknown>) : null;
    if (vad) {
      const { sensitivity, ...rest } = vad;
      s.vad = { ...rest, activationDb: migrateSensitivity(typeof sensitivity === "number" ? sensitivity : 60), bargeMarginDb: DEFAULT_BARGE_MARGIN_DB } as SettingsState["vad"];
    }
  }
  // v8 (top-bar clock + weather effects, decision 31): a manual atmosphere picked in the old top-bar
  // switch used to win forever, so reset it to Live ONCE. The Manual indicator (WeatherPanel status
  // line, the clock's effects dot) keeps any later manual pick visible. `effects` / `clock` are new
  // nested objects, backfilled by `merge`.
  if (from < 8 && s.weatherMode !== undefined) s.weatherMode = "auto";
  // v9 (section pass): Agent Chatter is off by default — internal agent back-and-forth is never
  // spoken unless Nic turns it back on (saves ElevenLabs credits). Reset once for existing installs.
  // (Was v8 on the section-pass branch; main's v8 weather reset already shipped, so this moved up.)
  if (from < 9 && isPlainObject(s.routing)) s.routing = { ...s.routing, vocalHandoffs: false };
  // v10 (section pass, 20.5): live captions off by default — each one is an extra Whisper pass on
  // the GPU competing with Tony. Only the old 600 ms default is reset; a spacing Nic chose stays.
  // (Was v9 on section-pass-batch3; renumbered when both branches merged into main.)
  if (from < 10 && isPlainObject(s.vad) && (s.vad as { partialMs?: unknown }).partialMs === 600) s.vad = { ...s.vad, partialMs: 0 };
  // `merge` (below) backfills any still-missing fields right after this runs.
  return s as unknown as SettingsState;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...defaults,
      set: (patch) => set(patch),
    }),
    {
      name: "cc.settings",
      version: 10,
      migrate: migrateSettings,
      // Deep-merge (not zustand's default shallow merge) so a persisted nested object missing a
      // newer field (e.g. an old `brainstorm` without `listenProfile`) is backfilled from defaults
      // instead of leaving that field `undefined`. Runs on every load, not just on a version bump.
      merge: (persisted, current) => {
        const s = deepMergeDefaults(persisted as DeepPartial<SettingsState> | null | undefined, current);
        // Phone app: the desktop loopback default is the phone itself, and anything that isn't an
        // http(s) URL (e.g. the token pasted into the URL box) can't be a gateway. Both fall back to
        // the NetBird HTTPS gateway, which also drops a pasted token from storage.
        if (isAndroidApp() && (LOOPBACK_GATEWAY.test(s.gatewayUrl) || !/^https?:\/\/[^\s/]+/i.test(s.gatewayUrl))) s.gatewayUrl = PHONE_GATEWAY;
        return s;
      },
      // Never write the bearer token to disk. `deepMergeDefaults` backfills it from `defaults`
      // (empty string) on every load, same as any other field a persisted snapshot doesn't have.
      partialize: ({ gatewayToken: _gatewayToken, ...rest }) => rest,
    },
  ),
);
