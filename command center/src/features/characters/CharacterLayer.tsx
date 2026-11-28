import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BellOff, Bell, EyeOff, Settings2 } from "lucide-react";
import { useCharacters, type CharacterPop } from "./character-store";
import { CHARACTERS, type CharacterDef } from "./roster";
import { DRAWINGS } from "./drawings";
import { bubbleSpot, placeCharacter, type Corner, type Rect } from "./logic";
import { usePrefersReducedMotion } from "@/lib/use-media-query";
import { motionLevel } from "@/lib/motion";
import { resolvedFor, useAppearance } from "@/features/appearance/appearance-store";
import { useNav } from "@/stores/nav";
import { useToasts } from "@/features/reminders/notify";
import { requestSettingsTab } from "@/sections/settings/settings-tab";

/**
 * UI fixes 2: the overlay layer for live characters. It sits above the page and the voice orb but
 * below widget windows, modals, confirmation cards and toasts (App.tsx's layer map), and the layer
 * itself takes no clicks: only the character's own small body does, and its speech bubble never
 * does. Each character picks a corner that touches no safety control, navigation or dock, and
 * moves if one appears there. Reduced motion (the OS setting, or Appearance → Motion) drops the
 * idle motion and the hop. Right-click or press and hold a character for Mute / Hide.
 */
export const CHARACTER_SIZE = 64;
/** What a character never sits on: safety controls, navigation, docks that opt in. */
export const AVOID = "[data-safety],nav,[data-char-avoid]";

const LONG_PRESS_MS = 500;

export function CharacterLayer() {
  const visible = useCharacters((s) => s.visible);
  const chars = useCharacters((s) => s.chars);
  if (!visible) return null;
  return (
    <>
      {CHARACTERS.filter((c) => chars[c.id]?.on ?? true).map((c) => (
        <CharacterSprite key={c.id} def={c} />
      ))}
    </>
  );
}

/** Calm motion: the OS reduced-motion setting, or Appearance → Motion not on Full for this page. */
function useCalm(): boolean {
  const os = usePrefersReducedMotion();
  const section = useNav((s) => s.section);
  const pref = useAppearance((s) => resolvedFor(s, section).motion);
  return os || pref !== "full";
}

function obstacles(self: Element | null): Rect[] {
  if (typeof document === "undefined") return [];
  const out: Rect[] = [];
  for (const el of document.querySelectorAll(AVOID)) {
    if (self && (self.contains(el) || el.contains(self))) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  return out;
}

function CharacterSprite({ def }: { def: CharacterDef }) {
  const corner = useCharacters((s) => s.chars[def.id]?.corner ?? def.corner);
  const pop = useCharacters((s) => (s.pop?.id === def.id ? s.pop : null));
  const muted = useCharacters((s) => s.muted);
  const section = useNav((s) => s.section);
  const calm = useCalm();
  const self = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<(Rect & { corner: Corner }) | null>(null);
  const [bubble, setBubble] = useState<Rect | null>(null);
  const [anim, setAnim] = useState<"" | "idle" | "pop" | "react">("");
  const [menu, setMenu] = useState(false);
  const hold = useRef<{ t: number; fired: boolean } | null>(null);
  const Drawing = DRAWINGS[def.id];

  // Where to sit: on mount, resize, a page change, a pop, and every few seconds (a safety control can appear).
  useLayoutEffect(() => {
    const place = () => {
      if (typeof window === "undefined") return;
      const obs = obstacles(self.current);
      const spot = placeCharacter(corner, window.innerWidth, window.innerHeight, CHARACTER_SIZE, obs);
      setAt((cur) => (cur && cur.x === spot.x && cur.y === spot.y && cur.corner === spot.corner ? cur : spot));
      setBubble(pop ? bubbleSpot(spot, obs, window.innerWidth, window.innerHeight) : null);
    };
    place();
    window.addEventListener("resize", place);
    const t = window.setInterval(() => !document.hidden && place(), 4000);
    return () => {
      window.removeEventListener("resize", place);
      window.clearInterval(t);
    };
  }, [corner, section, pop]);

  // A pop or a tap plays its motion once (never with calm motion: it just appears).
  useEffect(() => {
    if (!pop) return;
    if (calm) return setAnim("");
    setAnim(pop.kind === "react" ? "react" : "pop");
    const t = window.setTimeout(() => setAnim(""), 800);
    return () => window.clearTimeout(t);
  }, [pop, calm]);

  // At rest: a blink and a small bob now and then, in short bursts (nothing loops, so the GPU idles in between).
  useEffect(() => {
    if (calm || pop) return;
    let t: number;
    let off: number;
    const next = () => {
      t = window.setTimeout(() => {
        if (motionLevel() === "full" && !document.hidden) {
          setAnim("idle");
          off = window.setTimeout(() => setAnim(""), 1300);
        }
        next();
      }, 8000 + Math.random() * 5000);
    };
    next();
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(off);
    };
  }, [calm, pop]);

  // The quick menu closes on a click elsewhere or Esc.
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => !self.current?.contains(e.target as Node) && setMenu(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc);
    };
  }, [menu]);

  if (!at || !Drawing) return null;
  const right = at.corner === "br" || at.corner === "tr";
  const top = at.corner === "tr" || at.corner === "tl";
  const S = useCharacters.getState();

  return (
    <>
      <div ref={self} data-character={def.id} className="pointer-events-none fixed z-[60]" style={{ left: at.x, top: at.y, width: CHARACTER_SIZE, height: CHARACTER_SIZE }}>
        <button
          type="button"
          className="char-sprite pointer-events-auto block size-full touch-none select-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-teal/70"
          style={{ ["--char-origin" as string]: `${top ? "top" : "bottom"} ${right ? "right" : "left"}` }}
          data-up={pop ? "true" : "false"}
          data-anim={anim}
          aria-label={`${def.name}. Tap to say hi; right-click or press and hold for options.`}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => {
            if (hold.current?.fired) return void (hold.current = null);
            S.tap(def.id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu((v) => !v);
          }}
          onPointerDown={(e) => {
            if (e.pointerType === "mouse") return;
            const h = { t: 0, fired: false };
            h.t = window.setTimeout(() => {
              h.fired = true;
              setMenu(true);
              navigator.vibrate?.(10);
            }, LONG_PRESS_MS);
            hold.current = h;
          }}
          onPointerUp={() => hold.current && window.clearTimeout(hold.current.t)}
          onPointerCancel={() => hold.current && window.clearTimeout(hold.current.t)}
        >
          <Drawing title={def.name} />
        </button>
        {menu && (
          <div role="menu" aria-label={`${def.name} options`} className={`glass-chat pointer-events-auto absolute w-52 r-14 p-1.5 ${top ? "top-full mt-2" : "bottom-full mb-2"} ${right ? "right-0" : "left-0"}`}>
            <MenuItem
              icon={muted ? Bell : BellOff}
              label={muted ? "Unmute pop-ups" : "Mute pop-ups"}
              hint={muted ? undefined : "It stays in its corner; taps still work"}
              onClick={() => (S.setMuted(!muted), setMenu(false))}
            />
            <MenuItem
              icon={EyeOff}
              label="Hide characters"
              onClick={() => {
                S.setVisible(false);
                useToasts.getState().push({ title: "Characters hidden", body: "Bring them back in Settings → Appearance → Live characters.", tone: "info" });
              }}
            />
            <MenuItem
              icon={Settings2}
              label="Character settings"
              onClick={() => {
                setMenu(false);
                requestSettingsTab("appearance");
                useNav.getState().go("settings");
              }}
            />
          </div>
        )}
      </div>
      {pop && bubble && <Bubble pop={pop} rect={bubble} calm={calm} />}
    </>
  );
}

function MenuItem({ icon: Icon, label, hint, onClick }: { icon: typeof Bell; label: string; hint?: string; onClick: () => void }) {
  return (
    <button role="menuitem" onClick={onClick} className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left fs-12 text-ink-2 hover:bg-white/5 hover:text-ink">
      <Icon size={13} className="mt-0.5 shrink-0" />
      <span>
        {label}
        {hint && <span className="block fs-10 text-ink-3">{hint}</span>}
      </span>
    </button>
  );
}

/** The speech bubble: never takes a click, never sits on an obstacle (bubbleSpot), read out politely. */
function Bubble({ pop, rect, calm }: { pop: CharacterPop; rect: Rect; calm: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`glass-chat pointer-events-none fixed z-[60] flex items-center r-14 px-3 py-2 fs-13 text-ink ${calm ? "" : "char-bubble"}`}
      style={{ left: rect.x, top: rect.y, width: rect.w, minHeight: rect.h }}
    >
      {pop.text}
    </div>
  );
}
