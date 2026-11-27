import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVoice } from "@/features/voice/voice-store";
import type { AnchoredPopover } from "./TopBarClock.contract";

// Contract: ./TopBarClock.contract.ts (LOCKED 2026-11-26) — AnchoredPopover / UseAnchoredPopover / PopoverPosition.
// Extracted from features/modes/ModePill.tsx (its behaviour is unchanged): a trigger-anchored popover,
// portaled by the caller to <body> at z-40 (under the VoiceHUD z-50, the modals z-75…z-85, the ConfirmCard
// z-90 and the Toasts z-95), position:fixed under the trigger.

/** ModePill's width, and popoverPosition's default (mode-pill.test.ts pins it). */
export const POPOVER_W = 320;

/** Opaque card: no backdrop filter, no glass (it paints over the System Map's WebGL canvas). */
export const POPOVER_CARD = "r-14 border border-white/10 bg-[rgba(11,13,17,0.94)] p-2 shadow-[0_18px_48px_rgba(0,0,0,0.55)]";

/** Never wider than the screen minus 8 px each side: a 360 px popover on a 360 px screen is 344 px. */
export function clampPopoverWidth(requested: number, vw: number): number {
  return Math.max(0, Math.min(requested, vw - 16));
}

/** Where the popover sits: under the trigger, right-aligned to it, kept inside the viewport. `w` is the clamped width. */
export function popoverPosition(r: { left: number; right: number; bottom: number }, vw: number, w: number = POPOVER_W): { top: number; left: number } {
  const left = Math.min(Math.max(8, r.right - w), Math.max(8, vw - w - 8));
  return { top: r.bottom + 8, left };
}

/**
 * Escape closes the popover, except while a confirmation card is pending: the card (ConfirmCard, raised e.g.
 * by "Add to Google Calendar" inside the alarms popover) listens on window in the bubble phase, and a capture
 * listener that stopped the key would leave the card up until a second Escape or its timeout.
 */
export function popoverTakesEscape(key: string, confirmationPending: boolean): boolean {
  return key === "Escape" && !confirmationPending;
}

export function useAnchoredPopover(width: number): AnchoredPopover {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [w, setW] = useState(() => (typeof window === "undefined" ? width : clampPopoverWidth(width, window.innerWidth)));
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const vw = window.innerWidth;
      const cw = clampPopoverWidth(width, vw);
      setW(cw);
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) setPos(popoverPosition(r, vw, cw));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, width]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!popoverTakesEscape(e.key, !!useVoice.getState().pending)) return;
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !triggerRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  return { open, setOpen, triggerRef, popRef, pos, width: w };
}
