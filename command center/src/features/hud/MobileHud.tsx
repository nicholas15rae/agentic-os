import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { CandlestickChart, Cloud, Cpu, FlaskConical, Languages, Layers, Lock, MessagesSquare, MicOff, Network, Phone, ShieldCheck, ShieldOff } from "lucide-react";
import { gateway } from "@/lib/gateway";
import { cc, type MarketData } from "@/lib/cc-api";
import { cmd, isTauri, type ComputeMode } from "@/lib/platform";
import { useOs, useOsName } from "@/features/os/os-store";
import { useVoice, type ThreadId } from "@/features/voice/voice-store";
import { CommandInput, MicButton, STATE_DOT, Transcript } from "@/features/voice/VoiceParts";
import { SUB_AGENTS, type AgentRole } from "@/features/dispatcher/agents";
import { supplyDemandZones } from "@/features/trading/analysis";
import { TvChart } from "@/features/trading/TvChart";
import { toTradingView } from "@/features/trading/analysis";
import { CommsPanel } from "@/sections/CommsSection";
import { IdeasLedger, PipelineBars, PlayCards } from "@/sections/PlayPlaceSection";
import { GabagoolPill } from "@/features/os/OsControls";
import { usePipelines } from "@/features/os/pipeline-store";
import { useModes } from "@/features/modes/modes-store";
import { viewFromMirror, type Curiosity, type TonyMode } from "@/features/modes/modes";
import { isOverridden } from "@/features/modes/mode-ui";
import { ModeStripView } from "@/features/modes/ModeStrip";
import { requestMicEnabled, useMic } from "@/features/voice/mic-gate";
import { MicLockBadge } from "@/features/voice/MicLockBadge";
import { hudMicChips } from "@/features/voice/mic-indicator";
import { applyOptimistic, type HudCommand, type OsStatus } from "./hud-status";

const LanguageHub = lazy(() => import("@/features/language/LanguageHub").then((m) => ({ default: m.LanguageHub })));

/**
 * Galaxy S22 "Lockdown Command Center" — /mobile-hud (→ /cc/?view=hud).
 * Five tabs, nothing else: Tony & pipelines, Comms, Markets, Play Place & tasks, Language Hub.
 * `?mode=lockdown` = pure-black OLED, full screen on first tap; pair with a
 * Samsung Modes & Routines mode that pauses Instagram & co (see HANDOFF.md).
 */
type Tab = "tony" | "comms" | "markets" | "play" | "language";
const TABS: { id: Tab; label: string; icon: typeof Phone }[] = [
  { id: "tony", label: "Tony", icon: MessagesSquare },
  { id: "comms", label: "Comms", icon: Phone },
  { id: "markets", label: "Markets", icon: CandlestickChart },
  { id: "play", label: "Play Place", icon: FlaskConical },
  { id: "language", label: "Language", icon: Languages },
];


function useStatus() {
  const desktopCfg = useOs((s) => s.cfg);
  const [remote, setRemote] = useState<OsStatus | null>(null);
  const load = useCallback(() => void gateway<OsStatus & { available: boolean }>("/api/os/state").then(setRemote).catch(() => undefined), []);
  useEffect(() => {
    if (isTauri()) return;
    load();
    const iv = setInterval(load, 10_000);
    return () => clearInterval(iv);
  }, [load]);
  const status: OsStatus | null = desktopCfg ? { computeMode: desktopCfg.compute.mode, privacy: desktopCfg.privacy, scheduler: desktopCfg.scheduler, runtime: remote?.runtime } : remote;
  // Phone: the voice controller's Tier-3 decision follows the desktop's mode (one poll behind).
  const mirrorMode = remote?.mode;
  useEffect(() => {
    if (isTauri() || !mirrorMode?.id) return;
    const v = viewFromMirror(mirrorMode);
    useModes.setState({ modes: v.modes, activeId: v.active_mode_id, effective: v.effective, overrides: v.overrides, builtinIds: v.builtin_ids, loaded: true, error: null });
  }, [mirrorMode]);
  const send = async (payload: HudCommand) => {
    if (isTauri()) {
      const m = useModes.getState();
      const quiet = (p: Promise<unknown>) => p.catch(() => undefined); // errors surface in the stores
      if (payload.modeId) await quiet(m.setActive(payload.modeId));
      if (payload.overrides) await quiet(m.override(payload.overrides));
      if (payload.resetOverrides) await quiet(m.reset());
      if (payload.micEnabled !== undefined) await requestMicEnabled(payload.micEnabled);
      if (payload.killSwitch !== undefined || payload.computeMode)
        await useOs.getState().patch({ ...(payload.killSwitch !== undefined ? { privacy: { killSwitch: payload.killSwitch } } : {}), ...(payload.computeMode ? { compute: { mode: payload.computeMode } } : {}) });
      return;
    }
    // Optimistic; the desktop applies it within ~3 s and the mirror confirms.
    setRemote((r) => (r ? applyOptimistic(r, payload) : r));
    await gateway("/api/os/inbox", { method: "POST", body: JSON.stringify({ kind: "command", payload }) });
    setTimeout(load, 4000);
  };
  return { status, send };
}

type Hud = ReturnType<typeof useStatus>;

/** Tony's modes for the HUD: the desktop store on desktop, the mirror on the phone. */
function useHudModes(hud: Hud): { modes: TonyMode[]; activeId: string; name: string; curiosity: Curiosity; overridden: boolean } | null {
  const desk = useModes();
  if (isTauri()) return { modes: desk.modes, activeId: desk.activeId, name: desk.effective.name, curiosity: desk.effective.curiosity, overridden: isOverridden(desk.overrides) };
  const m = hud.status?.mode;
  if (!m?.id) return null;
  const v = viewFromMirror(m);
  return { modes: v.modes, activeId: v.active_mode_id, name: v.effective.name, curiosity: v.effective.curiosity, overridden: v.effective.overridden.length > 0 };
}

export function MobileHud() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const lockdown = params.get("mode") === "lockdown";
  const [tab, setTab] = useState<Tab>(() => (["tony", "comms", "markets", "play", "language"].includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "tony"));
  const name = useOsName();
  const hud = useStatus();

  // Install as its own portrait app (Samsung Routines can open it directly).
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]') ?? Object.assign(document.createElement("link"), { rel: "manifest" });
    link.href = "manifest-hud.webmanifest";
    document.head.appendChild(link);
    document.title = `${name} · Lockdown`;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#000000");
  }, [name]);
  // Lockdown: go full screen on the first touch (browsers require a gesture).
  useEffect(() => {
    if (!lockdown) return;
    const go = () => void document.documentElement.requestFullscreen?.().catch(() => undefined);
    window.addEventListener("pointerdown", go, { once: true });
    return () => window.removeEventListener("pointerdown", go);
  }, [lockdown]);

  return (
    <div className={`flex h-dvh flex-col ${lockdown ? "bg-black" : "bg-canvas"} text-ink`}>
      <StatusBar lockdown={lockdown} hud={hud} />
      <main className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {tab === "tony" && <TonyTab hud={hud} />}
        {tab === "comms" && <CommsPanel compact />}
        {tab === "markets" && <MarketsTab />}
        {tab === "language" && (
          <Suspense fallback={<div className="grid h-40 place-items-center font-mono text-xs text-ink-3">loading…</div>}>
            <LanguageHub compact />
          </Suspense>
        )}
        {tab === "play" && (
          <div className="space-y-3">
            <PipelineBars />
            <PlayCards compact />
            <IdeasLedger compact />
          </div>
        )}
      </main>
      <nav className="grid grid-cols-5 border-t border-white/10 bg-black/80 pb-[env(safe-area-inset-bottom)] backdrop-blur" aria-label="Command center tabs">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)} aria-current={tab === id ? "page" : undefined} className={`flex flex-col items-center gap-1 py-2.5 text-[10px] uppercase tracking-wider ${tab === id ? "text-amber-light" : "text-ink-3"}`}>
            <Icon size={20} />
            {id === "tony" ? name : label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function StatusBar({ lockdown, hud }: { lockdown: boolean; hud: Hud }) {
  const { status, send } = hud;
  const phoneMic = useMic((s) => s.enabled);
  const micChips = hudMicChips(phoneMic, status?.voice?.micEnabled, isTauri());
  const mode = useHudModes(hud);
  const mesh = location.hostname.startsWith("100.") || location.hostname === "127.0.0.1" || location.hostname === "localhost" || isTauri();
  const modes: { id: ComputeMode; icon: typeof Cpu }[] = [
    { id: "local", icon: Cpu },
    { id: "hybrid", icon: Layers },
    { id: "cloud", icon: Cloud },
  ];
  const kill = status?.privacy.killSwitch ?? false;
  return (
    <header className="flex flex-wrap items-center gap-1.5 px-3 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
      {lockdown && (
        <span className="flex items-center gap-1 rounded-full bg-amber/20 px-2 py-1 font-mono text-[10px] font-bold tracking-wider text-amber-light">
          <Lock size={10} /> LOCKDOWN
        </span>
      )}
      {micChips.map((c) => (
        <span key={c} role="status" className="flex items-center gap-1 rounded-full bg-alert/20 px-2 py-1 font-mono text-[10px] font-bold tracking-wider text-alert">
          <MicOff size={10} /> {c}
        </span>
      ))}
      <div className="flex rounded-full border border-white/10 p-0.5" role="radiogroup" aria-label="Compute mode">
        {modes.map(({ id, icon: Icon }) => (
          <button key={id} role="radio" aria-checked={status?.computeMode === id} onClick={() => void send({ computeMode: id })} className={`flex h-7 items-center gap-1 rounded-full px-2 font-mono text-[10px] ${status?.computeMode === id ? "bg-white/15 text-ink" : "text-ink-3"}`}>
            <Icon size={11} />
            {id.toUpperCase()}
          </button>
        ))}
      </div>
      <span className={`flex items-center gap-1 rounded-full border border-white/10 px-2 py-1 font-mono text-[10px] ${status?.privacy.diffuser ? "text-teal" : "text-ink-3"}`} title="Privacy diffuser">
        <ShieldCheck size={11} /> DIFFUSER {status?.privacy.diffuser ? "ON" : "OFF"}
      </span>
      <span className={`flex items-center gap-1 rounded-full border border-white/10 px-2 py-1 font-mono text-[10px] ${mesh && status?.privacy.networkLock ? "text-teal" : "text-amber-soft"}`} title="NetBird mesh">
        <Network size={11} /> MESH {mesh && status?.privacy.networkLock ? "LOCKED" : "OPEN"}
      </span>
      <button
        role="switch"
        aria-checked={kill}
        onClick={() => void send({ killSwitch: !kill })}
        className={`ml-auto flex h-8 items-center gap-1 rounded-full px-3 font-mono text-[10px] font-bold ${kill ? "bg-alert text-white" : "border border-alert/40 text-alert"}`}
      >
        <ShieldOff size={12} /> {kill ? "LOCAL ONLY" : "KILL"}
      </button>
      <div className="flex w-full flex-wrap items-center gap-1.5">
        {status?.scheduler && (
          <span className="rounded-full border border-white/10 px-2 py-1 font-mono text-[10px] text-ink-2" title="Compute split">
            SPLIT {status.scheduler.profile.toUpperCase()} · {status.scheduler.tonyPriorityPct}/{100 - status.scheduler.tonyPriorityPct}
          </span>
        )}
        {status?.runtime?.droplet && status.runtime.droplet.state !== "disabled" && (
          <span className={`rounded-full border border-white/10 px-2 py-1 font-mono text-[10px] ${status.runtime.droplet.state === "connected" ? "text-teal" : "text-alert"}`} title={status.runtime.droplet.detail}>
            DROPLET {status.runtime.droplet.state.toUpperCase()}
          </span>
        )}
        <SlotChip />
        {mode && (
          <span className="rounded-full border border-teal/30 px-2 py-1 font-mono text-[10px] text-teal" title="Tony's mode (switch it on the Tony tab)">
            MODE {mode.name.toUpperCase()}
            {mode.overridden ? " *" : ""}
          </span>
        )}
        <span className="ml-auto">
          <GabagoolPill />
        </span>
      </div>
      {!status && <span className="w-full text-[10px] text-ink-3">Desktop status unavailable — check the gateway token in Settings.</span>}
    </header>
  );
}

/** Every mirrored thread: Tony's desktop conversation ("auto": the Command view / VoiceHUD) and
 * Ops included, so nothing Nic said to Tony or an agent said back is unreachable on the phone. */
export const HUD_THREADS: ThreadId[] = ["general", "auto", "prompter", "designer", "director", "coder", "librarian", "booking", "ops", "bizops", "finance"];

function TonyTab({ hud }: { hud: Hud }) {
  const mode = useHudModes(hud);
  const deskMicOff = !isTauri() && hud.status?.voice?.micEnabled === false;
  const raw = useVoice((s) => s.activeThread);
  const thread: ThreadId = HUD_THREADS.includes(raw) ? raw : "general";
  const setThread = useVoice((s) => s.setActiveThread);
  const state = useVoice((s) => s.state);
  const name = useOsName();
  useEffect(() => {
    if (!HUD_THREADS.includes(raw)) setThread("general");
  }, [raw, setThread]);
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1">
        {HUD_THREADS.map((t) => (
          <button key={t} onClick={() => setThread(t)} className={`h-8 shrink-0 rounded-full border px-3 text-xs ${thread === t ? "border-amber/60 bg-amber/15 text-ink" : "border-white/10 text-ink-2"}`}>
            {t === "general" ? name : t === "auto" ? `${name} · desk` : SUB_AGENTS[t as AgentRole].label}
          </button>
        ))}
      </div>
      {mode && (
        <ModeStripView
          modes={mode.modes}
          activeId={mode.activeId}
          curiosity={mode.curiosity}
          overridden={mode.overridden}
          onSelect={(id) => void hud.send({ modeId: id })}
          onCuriosity={(c) => void hud.send({ overrides: { curiosity: c } })}
          onReset={() => void hud.send({ resetOverrides: true })}
        />
      )}
      <PipelineBars />
      <div className="min-h-[40vh] flex-1 rounded-[16px] border border-white/[0.06] bg-white/[0.02] p-3">
        <Transcript thread={thread} max={60} />
      </div>
      <div className="flex items-center gap-2">
        <span className={`size-2 shrink-0 rounded-full ${STATE_DOT[state]}`} />
        <MicButton size={48} />
        <div className="flex-1">
          <CommandInput thread={thread} placeholder={`Talk to ${thread === "general" ? name : SUB_AGENTS[thread as AgentRole].label}…`} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <MicLockBadge variant="button" />
        {!isTauri() && (
          <button
            type="button"
            disabled={deskMicOff}
            onClick={() => void hud.send({ micEnabled: false })}
            title="Lock the desktop's mic off (unlock it on the desktop)"
            className="flex h-8 items-center gap-1 rounded-full border border-alert/40 px-3 font-mono text-[10px] font-bold tracking-wider text-alert disabled:opacity-50"
          >
            <MicOff size={11} /> {deskMicOff ? "DESK MIC OFF" : "LOCK DESKTOP MIC"}
          </button>
        )}
      </div>
    </div>
  );
}

const WATCH_KEY = "cc.hud.watchlist";
function MarketsTab() {
  const [list] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(WATCH_KEY) ?? "") as string[];
    } catch {
      return ["SPY", "QQQ", "ES=F", "NQ=F", "BTC-USD", "SHOP.TO"];
    }
  });
  const [sym, setSym] = useState(list[0] ?? "SPY");
  const [data, setData] = useState<MarketData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      (isTauri() ? cmd("market_candles", { symbol: sym, interval: "5m", range: "5d" }) : cc.candles(sym, "5m", "5d"))
        .then((d) => live && (setData(d), setErr(null)))
        .catch((e) => live && setErr(String(e)));
    void load();
    const iv = setInterval(() => !document.hidden && void load(), 30_000);
    return () => {
      live = false;
      clearInterval(iv);
    };
  }, [sym]);
  const zones = useMemo(() => (data ? supplyDemandZones(data.candles) : []), [data]);
  const price = data?.price ?? data?.candles.at(-1)?.c ?? null;
  return (
    <div className="space-y-3">
      <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3">
        {list.map((s) => (
          <button key={s} onClick={() => setSym(s)} className={`h-8 shrink-0 rounded-full border px-3 font-mono text-xs ${sym === s ? "border-teal/60 bg-teal/15 text-ink" : "border-white/10 text-ink-2"}`}>
            {s}
          </button>
        ))}
      </div>
      <TvChart symbol={toTradingView(sym)} interval="5" height={300} />
      <div className="rounded-[16px] border border-white/[0.06] bg-white/[0.02] p-3">
        <div className="mb-2 flex items-baseline gap-2">
          <span className="font-mono text-sm text-ink">{sym}</span>
          <span className="font-mono text-lg text-amber-light">{price?.toFixed(2) ?? "—"}</span>
          <span className="ml-auto text-[10px] text-ink-3">Supply / demand · 5m · research only</span>
        </div>
        {err && <p className="text-xs text-alert">{err}</p>}
        <ul className="space-y-1">
          {zones
            .slice()
            .sort((a, b) => b.high - a.high)
            .map((z, i) => (
              <li key={i} className="flex items-center gap-2 font-mono text-xs">
                <span className={`w-14 ${z.kind === "supply" ? "text-alert" : "text-teal"}`}>{z.kind.toUpperCase()}</span>
                <span className="text-ink">
                  {z.low.toFixed(2)} – {z.high.toFixed(2)}
                </span>
                <span className="ml-auto text-ink-3">
                  {z.strength.toFixed(1)}×ATR · {z.tests} tests
                </span>
              </li>
            ))}
          {data && !zones.length && <li className="text-xs text-ink-3">No fresh zones on this range.</li>}
        </ul>
      </div>
    </div>
  );
}

/** Active slot on the phone: the running pipeline stage (the desktop holds the GPU baton). */
function SlotChip() {
  const runs = Object.values(usePipelines((s) => s.runs));
  const r = runs.sort((a, b) => b.at - a.at)[0];
  return (
    <span className={`rounded-full border border-white/10 px-2 py-1 font-mono text-[10px] ${r ? "text-amber-light" : "text-ink-3"}`}>
      SLOT {r ? `${r.stage.toUpperCase()} ${r.pct}%` : "TONY READY"}
    </span>
  );
}
