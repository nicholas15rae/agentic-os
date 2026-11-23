import type { MutableRefObject } from "react";

/** Orbit-camera angles, written by the WebGL scene each frame. */
export interface CameraView {
  az: number;
  pol: number;
}

export interface Parallax {
  /** Call once per frame: pixel offset at depth 1 (multiply by a layer's depth). */
  sample: (w: number, h: number) => { x: number; y: number };
  dispose: () => void;
}

/**
 * Camera + pointer parallax shared by every backdrop layer: the orbit azimuth is unwrapped (a full
 * turn never jumps), the pointer is smoothed, and the window-level listener is passive so it can
 * never intercept the star map's events.
 */
export function createParallax(view: MutableRefObject<CameraView>, el: () => Element | null): Parallax {
  const mouse = { tx: 0, ty: 0, x: 0, y: 0 };
  const onMove = (e: PointerEvent) => {
    const r = el()?.getBoundingClientRect();
    if (!r || !r.width) return;
    mouse.tx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
    mouse.ty = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
  };
  window.addEventListener("pointermove", onMove, { passive: true });
  let lastAz = view.current.az;
  const pol0 = view.current.pol;
  let camX = 0;
  return {
    sample(w, h) {
      let d = view.current.az - lastAz;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      lastAz = view.current.az;
      camX += d * w * 0.14;
      const camY = (view.current.pol - pol0) * h * 0.14;
      mouse.x += (mouse.tx - mouse.x) * 0.05;
      mouse.y += (mouse.ty - mouse.y) * 0.05;
      return { x: camX - mouse.x * 26, y: camY - mouse.y * 16 };
    },
    dispose: () => window.removeEventListener("pointermove", onMove),
  };
}
