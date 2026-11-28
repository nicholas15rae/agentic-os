import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BellOff, EyeOff, Settings2, X } from "lucide-react";
import { useCharacters, type CharacterPop } from "./character-store";
import { characterById, type CharacterDef } from "./roster";
import { DRAWINGS } from "./drawings";
import { bubbleSpot, placeCharacter, type Corner, type Rect } from "./logic";
import { usePrefersReducedMotion } from "@/lib/use-media-query";
import { resolvedFor, useAppearance } from "@/features/appearance/appearance-store";
import { useNav } from "@/stores/nav";
import { useToasts } from "@/features/reminders/notify";
import { requestSettingsTab } from "@/sections/settings/settings-tab";

/**
 * The overlay for pop-in characters. Nothing is drawn at rest. When one pops in it peeks from its
 * screen edge, says one line and ducks back out after a few seconds; clicking it opens its menu
 * (it stays while the menu is open). It sits above the page and the voice orb but below widget
 * windows, modals, confirmation cards and toasts (App.tsx's layer map); only its own small body
 * takes clicks, its bubble never does, and its spot touches no safety control, nav or dock.
 * Reduced motion (the OS setting, or Appearance → Motion) makes it fade instead of move.
 */
export const CHARACTER_SIZE = 64;
/** What a character never sits on: safety controls, navigation, docks that opt in. */
export const AVOID = "[data-safety],nav,[data-char-avoid]";
/** How long the duck-out takes before it is gone. */
const LEAVE_MS = 260;

export function CharacterLayer() {
  const pop = useCharacters((s) => s.pop);
  const [shown, setShown] = useState<CharacterPop | null>(null);
  const [leaving, setLeaving] = useState(false);
  // Keep the last pop on screen while it ducks out.
  useEffect(() => {
    if (pop) {
      setShown(pop);
      setLeaving(false);
      return;
    }
    if (!shown) return;
    setLeaving(true);
    const t = window.setTimeout(() => (setShown(null), setLeaving(false)), LEAVE_MS);
    return () => window.clearTimeout(t);
  }, [pop]); // eslint-disable-line react-hooks/exhaustive-deps
  const def = shown && characterById(shown.id);
  if (!shown || !def) return null;
  return <CharacterSprite key={shown.at} def={def} pop={shown} leaving={leaving} />;
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

function CharacterSprite({ def, pop, leaving }: { def: CharacterDef; pop: CharacterPop; leaving: boolean }) {
  const corner = useCharacters((s) => s.chars[def.id]?.corner ?? def.corner);
  const calm = useCalm();
  const self = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<(Rect & { corner: Corner }) | null>(null);
  const [bubble, setBubble] = useState<Rect | null>(null);
  const [menu, setMenu] = useState(false);
  const Drawing = DRAWINGS[def.id];

  // Where to peek in: a spot by its edge that touches no obstacle (checked once, on arrival).
  useLayoutEffect(() => {
    const obs = obstacles(self.current);
    const spot = placeCharacter(corner, window.innerWidth, window.innerHeight, CHARACTER_SIZE, obs);
    setAt(spot);
    setBubble(bubbleSpot(spot, obs, window.innerWidth, window.innerHeight));
  }, [corner]);

  // The menu keeps him here; closing it (or a click elsewhere / Esc) lets him go.
  const menuSeen = useRef(false);
  useEffect(() => {
    if (menu || menuSeen.current) useCharacters.getState().hold(menu);
    if (menu) menuSeen.current = true;
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
  const close = (then?: () => void) => {
    setMenu(false);
    then?.();
  };

  return (
    <>
      <div ref={self} data-character={def.id} className="pointer-events-none fixed z-[60]" style={{ left: at.x, top: at.y, width: CHARACTER_SIZE, height: CHARACTER_SIZE }}>
        <button
          type="button"
          className="char-sprite pointer-events-auto block size-full select-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-teal/70"
          data-side={right ? "right" : "left"}
          data-phase={leaving ? "out" : "in"}
          data-calm={calm ? "true" : "false"}
          aria-label={`${def.name}. Open his menu.`}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((v) => !v)}
          onContextMenu={(e) => (e.preventDefault(), setMenu(true))}
        >
          <Drawing title={def.name} />
        </button>
        {menu && (
          <div role="menu" aria-label={`${def.name} options`} className={`glass-chat pointer-events-auto absolute w-52 r-14 p-1.5 ${top ? "top-full mt-2" : "bottom-full mb-2"} ${right ? "right-0" : "left-0"}`}>
            <MenuItem icon={BellOff} label="Mute pop-ups" hint="No more pop-ins until you unmute in Settings" onClick={() => close(() => S.setMuted(true))} />
            <MenuItem
              icon={EyeOff}
              label="Hide characters"
              onClick={() =>
                close(() => {
                  S.setVisible(false);
                  useToasts.getState().push({ title: "Characters hidden", body: "Bring them back in Settings → Appearance → Live characters.", tone: "info" });
                })
              }
            />
            <MenuItem
              icon={Settings2}
              label="Character settings"
              onClick={() =>
                close(() => {
                  S.leave();
                  requestSettingsTab("appearance");
                  useNav.getState().go("settings");
                })
              }
            />
            <MenuItem icon={X} label="Bye for now" onClick={() => close(() => S.leave())} />
          </div>
        )}
      </div>
      {bubble && !leaving && !menu && <Bubble pop={pop} rect={bubble} calm={calm} />}
    </>
  );
}

function MenuItem({ icon: Icon, label, hint, onClick }: { icon: typeof X; label: string; hint?: string; onClick: () => void }) {
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
      className={`glass-chat pointer-events-none fixed z-[60] flex items-center r-14 px-3 py-2 fs-13 text-ink ${calm ? "char-bubble-fade" : "char-bubble"}`}
      style={{ left: rect.x, top: rect.y, width: rect.w, minHeight: rect.h }}
    >
      {pop.text}
    </div>
  );
}
