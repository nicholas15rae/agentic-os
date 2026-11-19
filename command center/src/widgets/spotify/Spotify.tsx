import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { History, ListMusic, Loader2, Music2, Pause, Play, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from "lucide-react";
import { Empty, WidgetHeader } from "@/components/WidgetHeader";
import type { WidgetProps } from "@/core/widgets/types";
import { cmd, isTauri, type SpotifyAction, type SpotifyItem, type SpotifyNowPlaying, type SpotifyStatus } from "@/lib/platform";
import { spotifyErrorReply } from "@/features/os/media-reply";
import { useSpotifyAuthRefresh, useSpotifyConnect } from "@/features/integrations/spotify-connect";
import {
  POLL_MS,
  VOLUME_DEBOUNCE_MS,
  fmtTime,
  isNoVolumeReply,
  muteTarget,
  noVolumeNote,
  needsReconnect,
  progressAt,
  progressFraction,
  seekSeconds,
  shownPosition,
  shownVolume,
  spotifyFix,
  spotifyFixText,
  volumeLevel,
  type QuickList,
} from "./spotify-ui";

const VOLUME_ICON = { mute: VolumeX, low: Volume1, high: Volume2 } as const;
/** Keys that move a range input: the scrubber seeks when one is released. */
const SEEK_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

type Config = { quick: QuickList };

export default function Spotify(props: WidgetProps<Config>) {
  if (!isTauri())
    return (
      <div className="flex h-full flex-col">
        <WidgetHeader title="Spotify" />
        <Empty>Spotify control runs in the desktop app.</Empty>
      </div>
    );
  return <SpotifyDesktop {...props} />;
}

function SpotifyDesktop(props: WidgetProps<Config>) {
  const [status, setStatus] = useState<SpotifyStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(
    () =>
      void cmd("spotify_status")
        .then((s) => (setStatus(s), setErr(null)))
        .catch((e) => setErr(spotifyErrorReply(e))),
    [],
  );
  useEffect(refresh, [refresh]);
  useSpotifyAuthRefresh(refresh);

  if (!status)
    return (
      <div className="flex h-full flex-col">
        <WidgetHeader title="Spotify" />
        <Empty>{err ?? "Checking Spotify…"}</Empty>
      </div>
    );
  if (!status.configured)
    return (
      <div className="flex h-full flex-col">
        <WidgetHeader title="Spotify" />
        <Empty>Spotify isn't set up yet — see Settings → Integrations.</Empty>
      </div>
    );
  // `problemKind` (from Rust) decides: a dead sign-in → Re-authenticate; the app owner needs
  // Premium → Check again; premium / transient problems (rate limit, outage, network) keep the
  // Player, whose polling recovers on its own.
  const fix = spotifyFix(status);
  if (fix === "connect") return <ConnectPanel onDone={refresh} />;
  // Allowlist / owner-Premium blocks: no sign-in helps, so only "Check again" (never a consent loop).
  if (fix && status.problem)
    return <ConnectPanel onDone={refresh} problem={status.problem} hint={spotifyFixText(fix)} recheckOnly={fix === "recheck" || fix === "allowlist"} />;
  return <Player {...props} onDisconnected={refresh} />;
}

function ConnectPanel({ onDone, problem, hint, recheckOnly = false }: { onDone: () => void; problem?: string; hint?: string | null; recheckOnly?: boolean }) {
  const { state, connect } = useSpotifyConnect(onDone);
  const waiting = state.phase === "waiting";
  return (
    <div className="flex h-full flex-col">
      <WidgetHeader title="Spotify" />
      <p className={`${hint ? "mb-1" : "mb-3"} text-sm ${problem ? "text-alert" : "text-ink-2"}`}>{problem ?? "Connect your Spotify account to see what's playing and control it from here."}</p>
      {hint && <p className="mb-3 text-xs text-ink-2">{hint}</p>}
      <button onClick={() => void (recheckOnly ? onDone() : connect())} disabled={waiting} className="pill-primary !h-9 w-fit text-[13px]">
        {waiting ? <Loader2 size={13} className="animate-spin" /> : <Music2 size={13} />} {recheckOnly ? "Check again" : problem ? "Re-authenticate" : "Connect Spotify"}
      </button>
      {waiting && (
        <p className="mt-2 text-xs text-ink-2">
          Waiting for Spotify… finish signing in in your browser.{" "}
          {state.url && (
            <a href={state.url} target="_blank" rel="noreferrer" className="text-teal underline">
              Open the sign-in page
            </a>
          )}
        </p>
      )}
      {state.phase === "error" && <p className="mt-2 text-xs text-alert">{state.error}</p>}
    </div>
  );
}

/** True while the widget is on screen and the window isn't hidden — polling only runs then. */
function useVisible(ref: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(true);
  const [docVisible, setDocVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  useEffect(() => {
    const on = () => setDocVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return inView && docVisible;
}

function Player({ config, setConfig, size, onDisconnected }: WidgetProps<Config> & { onDisconnected: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const visible = useVisible(rootRef);
  const [np, setNp] = useState<{ data: SpotifyNowPlaying; at: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [localVol, setLocalVol] = useState<{ value: number; at: number } | null>(null);
  const [localPos, setLocalPos] = useState<{ value: number; at: number } | null>(null);
  /** The scrubber's value while it is being dragged / keyed (committed on release). */
  const [scrub, setScrub] = useState<number | null>(null);
  const scrubRef = useRef<number | null>(null);
  /** A device that answered a volume change with the soft NO_VOLUME reply, and that reply. */
  const [noVol, setNoVol] = useState<{ device: string; reply: string } | null>(null);
  const lastVol = useRef<number | null>(null);
  const [lists, setLists] = useState<Partial<Record<QuickList, SpotifyItem[]>>>({});
  const [listErr, setListErr] = useState<string | null>(null);
  const seq = useRef(0);
  const followUp = useRef<ReturnType<typeof setTimeout>>(undefined);
  const volTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fail = useCallback(
    (e: unknown) => {
      const msg = spotifyErrorReply(e);
      setErr(msg);
      if (needsReconnect(msg)) onDisconnected();
    },
    [onDisconnected],
  );

  const poll = useCallback(async () => {
    const my = ++seq.current;
    try {
      const data = await cmd("spotify_now_playing");
      if (my !== seq.current) return;
      const at = Date.now();
      setNp({ data, at });
      setNow(at);
      setErr(null);
    } catch (e) {
      if (my === seq.current) fail(e);
    }
  }, [fail]);

  useEffect(() => {
    if (!visible) return;
    void poll();
    const t = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(t);
  }, [visible, poll]);

  const playing = !!np?.data.isPlaying;
  useEffect(() => {
    if (!visible || !playing) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [visible, playing]);

  useEffect(
    () => () => {
      clearTimeout(followUp.current);
      clearTimeout(volTimer.current);
    },
    [],
  );

  /** Re-poll now, and once more shortly after: Spotify reports the old state for a moment after a change. */
  const pollAfterChange = () => {
    void poll();
    clearTimeout(followUp.current);
    followUp.current = setTimeout(() => void poll(), 900);
  };

  // The last non-zero volume, for unmute.
  useEffect(() => {
    const v = np?.data.volume;
    if (v != null && v > 0) lastVol.current = v;
  }, [np]);

  // A click on the widget is the user's own action, so it counts as approval; Deny and the kill switch still refuse in Rust.
  const run = async (call: () => Promise<string>, onReply?: (reply: string) => void) => {
    try {
      const reply = await call();
      setErr(null);
      onReply?.(reply);
    } catch (e) {
      fail(e);
    }
    pollAfterChange();
  };
  const control = (action: SpotifyAction, value?: number) => {
    if (action === "pause" || action === "resume") {
      seq.current++; // an in-flight poll would undo the optimistic flip
      setNp((p) => {
        if (!p) return p;
        const at = Date.now();
        return { data: { ...p.data, isPlaying: action === "resume", progressMs: progressAt(p.data, p.at, at) }, at };
      });
    }
    if (action === "next" || action === "previous") setLocalPos(null);
    void run(() => cmd("spotify_control", { action, value, approved: true }));
  };
  /** Slider edits wait out the debounce; the mute button sends at once (`delay` 0). */
  const setVolume = (value: number, delay = VOLUME_DEBOUNCE_MS) => {
    if (value > 0) lastVol.current = value;
    setLocalVol({ value, at: Date.now() });
    clearTimeout(volTimer.current);
    const device = np?.data.device ?? "";
    // NO_VOLUME comes back as Ok: drop the optimistic level and disable the controls. Its line is
    // shown from `noVol` (not `err`, which the next poll clears) for as long as that device plays.
    const onReply = (reply: string) => {
      if (!isNoVolumeReply(reply)) return;
      setLocalVol(null);
      setNoVol({ device, reply });
    };
    volTimer.current = setTimeout(() => void run(() => cmd("spotify_control", { action: "volume", value, approved: true }), onReply), delay);
  };

  const showList = size.h >= 3;
  const tab = config.quick === "playlists" ? "playlists" : "recent";
  const loadList = useCallback(
    (which: QuickList) =>
      void (which === "recent" ? cmd("spotify_recent") : cmd("spotify_playlists"))
        .then((items) => (setLists((l) => ({ ...l, [which]: items })), setListErr(null)))
        .catch((e) => setListErr(spotifyErrorReply(e))),
    [],
  );
  const listLoaded = lists[tab] !== undefined;
  useEffect(() => {
    if (showList && visible && !listLoaded) loadList(tab);
  }, [showList, visible, listLoaded, tab, loadList]);

  const d = np?.data;
  const pos = scrub ?? (d ? shownPosition(progressAt(d, np.at, now), localPos, now, playing, d.durationMs) : 0);
  const vol = shownVolume(d?.volume ?? null, localVol, now);
  const items = lists[tab];
  const noVolNote = noVolumeNote(noVol, d?.device);
  const volWhy = vol == null ? "This device doesn't report its volume" : noVolNote;
  const VolIcon = vol == null ? Volume2 : VOLUME_ICON[volumeLevel(vol)];
  const fill = d ? progressFraction(pos, d.durationMs) * 100 : 0;

  /** Send the scrubbed position (whole seconds), optimistically: the bar holds it while polls catch up. */
  const commitSeek = () => {
    const ms = scrubRef.current;
    scrubRef.current = null;
    setScrub(null);
    if (ms == null || !d || d.durationMs <= 0) return;
    const sec = seekSeconds(ms, d.durationMs);
    const at = Date.now();
    seq.current++; // an in-flight poll would snap the bar back
    setLocalPos({ value: sec * 1000, at });
    setNp((p) => (p ? { data: { ...p.data, progressMs: sec * 1000 }, at } : p));
    setNow(at);
    void run(() => cmd("spotify_control", { action: "seek", value: sec, approved: true }));
  };
  // The window-level pointerup listener outlives this render: it calls the latest commitSeek.
  const commitRef = useRef(commitSeek);
  commitRef.current = commitSeek;
  /** A drag can end outside the input, so the release is caught on the window. */
  const onScrubStart = () => {
    const end = () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      commitRef.current();
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  const toggleMute = () => {
    if (vol != null && vol > 0) lastVol.current = vol;
    const target = muteTarget(vol, lastVol.current);
    if (target != null) setVolume(target, 0);
  };

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <WidgetHeader title="Spotify" status={d?.device ? <span className="label-caps max-w-32 truncate text-ink-3">{d.device}</span> : undefined} />

      <div className="flex min-w-0 items-center gap-3">
        {d?.artUrl ? (
          <img src={d.artUrl} alt="" className={`${showList ? "size-14" : "size-11"} shrink-0 rounded-[10px] object-cover`} />
        ) : (
          <div className={`${showList ? "size-14" : "size-11"} well grid shrink-0 place-items-center rounded-[10px] text-ink-3`}>
            <Music2 size={18} />
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink" title={d?.track ?? undefined}>
            {d?.track ?? (np ? "Nothing playing" : "…")}
          </p>
          <p className="truncate text-xs text-ink-2" title={d?.track ? d.artists.join(", ") : undefined}>
            {d?.track ? d.artists.join(", ") : np ? "Open Spotify on a device, or pick something below." : ""}
          </p>
          {showList && d?.track && d.album && (
            <p className="truncate text-[11px] text-ink-3" title={d.album}>
              {d.album}
            </p>
          )}
        </div>
      </div>

      {d?.track && (
        <div className="mt-2">
          <input
            type="range"
            min={0}
            max={Math.max(0, d.durationMs)}
            step={1000}
            value={Math.min(pos, Math.max(0, d.durationMs))}
            disabled={d.durationMs <= 0}
            onChange={(e) => {
              scrubRef.current = Number(e.target.value);
              setScrub(scrubRef.current);
            }}
            onPointerDown={onScrubStart}
            onKeyUp={(e) => SEEK_KEYS.has(e.key) && commitSeek()}
            onBlur={commitSeek}
            aria-label="Seek"
            aria-valuetext={`${fmtTime(pos)} of ${fmtTime(d.durationMs)}`}
            className="block h-3 w-full cursor-pointer appearance-none bg-transparent bg-[length:100%_4px] bg-center bg-no-repeat disabled:cursor-default [&::-webkit-slider-thumb]:size-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-teal-soft [&::-webkit-slider-thumb]:shadow-[0_0_6px_#00e5c3]"
            style={{ backgroundImage: `linear-gradient(to right, var(--color-teal) 0%, var(--color-teal-light) ${fill}%, rgba(255,255,255,0.08) ${fill}%)` }}
          />
          <div className="mt-0.5 flex justify-between font-mono text-[10px] text-ink-3 tabular">
            <span>{fmtTime(pos)}</span>
            <span>{fmtTime(d.durationMs)}</span>
          </div>
        </div>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <button aria-label="Previous track" onClick={() => control("previous")} className="well grid size-8 shrink-0 place-items-center rounded-full text-ink-2 hover:text-ink">
          <SkipBack size={14} />
        </button>
        <button
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => control(playing ? "pause" : "resume")}
          className="grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-tr from-teal to-teal-light text-canvas"
        >
          {playing ? <Pause size={15} /> : <Play size={15} className="translate-x-px" />}
        </button>
        <button aria-label="Next track" onClick={() => control("next")} className="well grid size-8 shrink-0 place-items-center rounded-full text-ink-2 hover:text-ink">
          <SkipForward size={14} />
        </button>
        {(d?.device || vol != null) && (
          <div className="ml-auto flex min-w-0 items-center gap-1" title={volWhy ?? undefined}>
            <button
              type="button"
              onClick={toggleMute}
              disabled={!!volWhy}
              aria-label="Mute Spotify"
              aria-pressed={vol === 0}
              title={volWhy ?? (vol === 0 ? "Unmute" : "Mute")}
              className="grid size-7 shrink-0 place-items-center rounded-full text-ink-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-ink-2"
            >
              <VolIcon size={14} />
            </button>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={vol ?? 0}
              disabled={!!volWhy}
              onChange={(e) => setVolume(Number(e.target.value))}
              aria-label="Spotify volume"
              title={volWhy ?? undefined}
              className="w-20 min-w-0 shrink accent-teal disabled:cursor-not-allowed disabled:opacity-40"
            />
          </div>
        )}
      </div>

      {(err ?? noVolNote) && <p className="mt-1.5 text-xs text-amber-light">{err ?? noVolNote}</p>}

      {showList && (
        <div className="mt-2 flex min-h-0 flex-1 flex-col">
          <div role="tablist" aria-label="Quick select" className="well mb-1.5 flex w-fit gap-0.5 rounded-full p-0.5">
            {(
              [
                ["recent", "Recent", History],
                ["playlists", "Playlists", ListMusic],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => (tab === id ? loadList(id) : setConfig({ quick: id }))}
                title={tab === id ? "Refresh" : label}
                className={`flex h-6 items-center gap-1 rounded-full px-2.5 text-[11px] ${tab === id ? "bg-white/10 text-ink" : "text-ink-3 hover:text-ink"}`}
              >
                <Icon size={11} /> {label}
              </button>
            ))}
          </div>
          <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            {listErr && <li className="text-xs text-amber-light">{listErr}</li>}
            {!listErr && !items && <li className="text-xs text-ink-3">Loading…</li>}
            {items?.length === 0 && <li className="text-xs text-ink-3">{tab === "recent" ? "Nothing played recently." : "No playlists yet."}</li>}
            {items?.map((it) => (
              <li key={it.uri}>
                <button
                  onClick={() => void run(() => cmd("spotify_play_uri", { uri: it.uri, approved: true }))}
                  className={`flex w-full min-w-0 items-center gap-2 rounded-[10px] px-1.5 py-1 text-left hover:bg-white/[0.06] ${d?.uri === it.uri ? "text-teal" : ""}`}
                  title={`Play ${it.title}`}
                >
                  {it.artUrl ? <img src={it.artUrl} alt="" loading="lazy" className="size-7 shrink-0 rounded-[6px] object-cover" /> : <span className="well size-7 shrink-0 rounded-[6px]" />}
                  <span className="min-w-0">
                    <span className="block truncate text-xs text-ink">{it.title}</span>
                    {it.subtitle && <span className="block truncate text-[11px] text-ink-3">{it.subtitle}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
