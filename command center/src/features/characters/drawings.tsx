import { useId, type ComponentType } from "react";

/**
 * UI fixes 2: each overlay character's drawing (inline SVG, original designs). Moving parts carry
 * classes the overlay animates (`char-body`, `char-eyes`, `char-coin`, see styles/index.css); the
 * motion is driven by `data-anim` on the wrapper, so nothing loops on its own.
 */
export type Drawing = ComponentType<{ title: string }>;

/** A ruffled disc edge: a circle whose radius ripples `n` times. Pure. */
export function wavyCircle(cx: number, cy: number, r: number, amp: number, n: number, steps = 96): string {
  const pts: string[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const rr = r + amp * Math.sin(a * n);
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)} ${(cy + rr * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
}

const RIM = wavyCircle(31.5, 33, 23.2, 0.8, 18);

/** Gabagool: a round, marbled slice with a cheeky face, holding a gold coin. */
function GabagoolDrawing({ title }: { title: string }) {
  const id = useId().replace(/:/g, "");
  const meat = `gab-meat-${id}`;
  const coin = `gab-coin-${id}`;
  return (
    <svg viewBox="0 0 64 64" width="100%" height="100%" role="img" aria-label={title} className="overflow-visible">
      <defs>
        <radialGradient id={meat} cx="45%" cy="40%" r="62%">
          <stop offset="0%" stopColor="#f39aa6" />
          <stop offset="70%" stopColor="#e06a7c" />
          <stop offset="100%" stopColor="#b8445a" />
        </radialGradient>
        <radialGradient id={coin} cx="38%" cy="35%" r="70%">
          <stop offset="0%" stopColor="#ffe48a" />
          <stop offset="60%" stopColor="#f5bf3a" />
          <stop offset="100%" stopColor="#c98a12" />
        </radialGradient>
      </defs>
      {/* Soft shadow on the ground. */}
      <ellipse cx="31" cy="60" rx="18" ry="2.6" fill="rgba(0,0,0,0.35)" />
      <g className="char-body">
        {/* Ruffled rim of the slice. */}
        <path d={RIM} fill="#a83a4f" />
        <circle cx="31.5" cy="33" r="21.5" fill={`url(#${meat})`} />
        {/* Marbling (the fat). */}
        <g fill="none" stroke="#fbe1e3" strokeLinecap="round" opacity="0.85">
          <path d="M16 26c4-3 7 1 11-1s5-5 9-4" strokeWidth="2.2" />
          <path d="M19 44c3 2 6-1 9 1s4 3 8 1" strokeWidth="1.8" />
          <path d="M40 46c2-2 5-1 7-3" strokeWidth="1.6" />
          <path d="M44 22c1 2 3 3 5 3" strokeWidth="1.4" />
          <circle cx="15.5" cy="35" r="1.4" fill="#fbe1e3" stroke="none" />
        </g>
        {/* Cheeks. */}
        <circle cx="19.5" cy="38" r="3.2" fill="#ff8fa3" opacity="0.7" />
        <circle cx="42.5" cy="38" r="3.2" fill="#ff8fa3" opacity="0.7" />
        {/* Eyes (blink together). */}
        <g className="char-eyes">
          <ellipse cx="24.5" cy="31" rx="3.6" ry="4.2" fill="#fff" />
          <ellipse cx="38" cy="31" rx="3.6" ry="4.2" fill="#fff" />
          <circle cx="25.4" cy="32" r="2" fill="#2a1418" />
          <circle cx="38.9" cy="32" r="2" fill="#2a1418" />
          <circle cx="26.1" cy="31.1" r="0.7" fill="#fff" />
          <circle cx="39.6" cy="31.1" r="0.7" fill="#fff" />
        </g>
        {/* A cheeky one-sided grin. */}
        <path d="M24.5 40.5c3 3.4 8.6 3.6 12.6-0.6" fill="none" stroke="#5a1e2a" strokeWidth="2" strokeLinecap="round" />
        <path d="M36.6 39.6l1.6-1.4" stroke="#5a1e2a" strokeWidth="1.8" strokeLinecap="round" />
        {/* Stubby arm to the coin. */}
        <path d="M47 41c2 1 3.5 2 4.5 3.5" stroke="#b8445a" strokeWidth="3.4" strokeLinecap="round" fill="none" />
      </g>
      <g className="char-coin">
        <circle cx="51.5" cy="49" r="8.5" fill={`url(#${coin})`} stroke="#a8730e" strokeWidth="1.2" />
        <circle cx="51.5" cy="49" r="5.8" fill="none" stroke="#fff3c4" strokeWidth="0.8" opacity="0.7" />
        <path d="M54.2 46.3a3.7 3.7 0 1 0 0.6 4.3h-3" fill="none" stroke="#8a5c08" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

export const DRAWINGS: Record<string, Drawing> = {
  gabagool: GabagoolDrawing,
};
