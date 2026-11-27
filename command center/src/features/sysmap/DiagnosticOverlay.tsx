import { useEffect, useState } from "react";
import { busPath, CARD_H, CARD_W, FLOW_NODES, linkPath, SPINE_X, TONY_BOX, USER_BOX } from "./model";
import type { Health, ProbeEvent, ProbeNode } from "./diagnostics.contract";
import { HEALTH_COLOR, healthOf, isTerminal } from "./diagnostics-model";
import { useDiag } from "./diagnostics-store";

/** How long a returning packet keeps travelling back along its conduit. */
const RETURN_MS = 1400;
const DISPATCH_COLOR = "#e2e8f0";
const PHASE_COLOR = { dispatched: DISPATCH_COLOR, queued: "#fbbf24", executing: "#22d3ee" } as const;

/**
 * The conduit a probe travels: Tony's comes down the USER → TONY line; the isolated Trading
 * Agent's runs over its Financer-only side link (never through Tony's spine); everyone else uses
 * their own bus trace off the spine (the bottom daemons via the daemon bus). Pure.
 */
export function conduitFor(n: ProbeNode): string {
  if (n === "tony") return `M ${SPINE_X} ${USER_BOX.y + USER_BOX.h / 2} V ${TONY_BOX.y - TONY_BOX.h / 2}`;
  if (n === "trading") return linkPath("finance", "trading");
  return busPath(n);
}

/** Card box (top-left + size) for a node, in schematic units. Pure. */
export function cardBox(n: ProbeNode): { x: number; y: number; w: number; h: number } {
  if (n === "tony") return { x: TONY_BOX.x - TONY_BOX.w / 2, y: TONY_BOX.y - TONY_BOX.h / 2, w: TONY_BOX.w, h: TONY_BOX.h };
  const p = FLOW_NODES[n];
  return { x: p.x - CARD_W / 2, y: p.y - CARD_H / 2, w: CARD_W, h: CARD_H };
}

function useProbes(): ProbeEvent[] {
  const probes = useDiag((s) => s.probes);
  return Object.values(probes).filter((p): p is ProbeEvent => !!p);
}

/** Re-render while any packet is still on its way back (no rAF; CSS animates the dashes). */
function useReturnTick(probes: ProbeEvent[]): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!probes.some((p) => isTerminal(p) && p.at + RETURN_MS > Date.now())) return;
    const t = setTimeout(() => setNow(Date.now()), 200);
    return () => clearTimeout(t);
  }, [probes, now]);
  return now;
}

/** Animated packets on the conduits (drawn under the cards). */
export function DiagnosticConduits() {
  const probes = useProbes();
  const intensity = useDiag((s) => s.runIntensity);
  const now = useReturnTick(probes);
  return (
    <g pointerEvents="none" aria-hidden>
      {probes.map((p) => {
        const n = p.node as ProbeNode;
        const d = conduitFor(n);
        if (!isTerminal(p)) {
          const c = PHASE_COLOR[p.phase as keyof typeof PHASE_COLOR];
          return <path key={`${p.runId}-${n}-out`} d={d} fill="none" stroke={c} strokeWidth={3} className="sysmap-flow" style={{ filter: `drop-shadow(0 0 5px ${c})` }} />;
        }
        if (now - p.at > RETURN_MS) return null;
        const c = HEALTH_COLOR[healthOf(p, intensity) ?? "red"];
        return <path key={`${p.runId}-${n}-back`} d={d} fill="none" stroke={c} strokeWidth={3} className="sysmap-flow-rev" style={{ filter: `drop-shadow(0 0 6px ${c})` }} />;
      })}
    </g>
  );
}

/** One-line badge text for a probe (pure). */
export function badgeText(p: ProbeEvent): string {
  if (!isTerminal(p)) return p.phase === "executing" && p.queueWaitMs != null ? `EXECUTING… · Queue: ${p.queueWaitMs}ms` : `${p.phase.toUpperCase()}…`;
  if (p.phase === "timeout") return `TIMEOUT · ${p.totalRttMs ?? "?"}ms`;
  if (p.phase === "error") return `ERROR · ${(p.error ?? "failed").slice(0, 30)}`;
  const tok = p.tokensPerSec != null ? ` · ${p.tokensPerSec} tok/s` : "";
  return `${p.totalRttMs}ms · Queue: ${p.queueWaitMs}ms | Exec: ${p.execMs}ms${tok}`;
}

const BADGE_W = 270;
const BADGE_H = 20;

/** Health rings + RTT badges (drawn over the cards; the badge straddles the card's top edge). */
export function DiagnosticBadges() {
  const probes = useProbes();
  const intensity = useDiag((s) => s.runIntensity);
  return (
    <g pointerEvents="none">
      {probes.map((p) => {
        const n = p.node as ProbeNode;
        const b = cardBox(n);
        const h: Health | null = healthOf(p, intensity);
        const c = h ? HEALTH_COLOR[h] : PHASE_COLOR[p.phase as keyof typeof PHASE_COLOR];
        const text = badgeText(p);
        const bx = b.x + b.w / 2 - BADGE_W / 2;
        const by = b.y - BADGE_H / 2 - 2;
        const long = text.length * 6.1 > BADGE_W - 16;
        return (
          <g key={`${p.runId}-${n}`} role="status" aria-label={`${n} probe: ${text}`}>
            <rect x={b.x - 5} y={b.y - 5} width={b.w + 10} height={b.h + 10} rx={13} fill="none" stroke={c} strokeWidth={h ? 2 : 1.6} strokeOpacity={h ? 0.9 : 0.75} className={h ? undefined : "sysmap-flow"} />
            <rect x={bx} y={by} width={BADGE_W} height={BADGE_H} rx={BADGE_H / 2} fill="rgba(4,7,12,0.96)" stroke={c} strokeWidth={1.2} />
            <circle cx={bx + 11} cy={by + BADGE_H / 2} r={3.5} fill={c} className={h ? undefined : "sysmap-blink"} />
            <text x={bx + 20} y={by + 14} className="sysmap-mono" fontSize={10} fill="#e2e8f0" {...(long ? { textLength: BADGE_W - 28, lengthAdjust: "spacingAndGlyphs" as const } : {})}>
              {text}
            </text>
          </g>
        );
      })}
    </g>
  );
}
