import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Shared layout system: a body that fills what is left of its panel (a flex child) and hands its
 * pixel height to content that needs a number (charts, canvases), so a chart grows and shrinks
 * with its panel instead of a fixed 440 px being cut off. Never below `min`.
 */
export function FillBox({ min = 240, children }: { min?: number; children: (height: number) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(min);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setH(Math.max(min, Math.floor(el.clientHeight)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [min]);
  return (
    <div ref={ref} className="relative min-h-0 flex-1" style={{ minHeight: min }}>
      {children(h)}
    </div>
  );
}
