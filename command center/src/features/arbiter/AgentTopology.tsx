import { useEffect, useMemo, useState } from "react";
import { useArbiter } from "./arbiter-store";
import { EDGES, LAYOUT, edgeKey, flashNode, nodeLook, pulseEdge } from "./agent-graph";
import type { ArbiterNode } from "./api";

/** How long a pulse / flash stays lit (CSS animation; no requestAnimationFrame loop). */
const PULSE_MS = 1400;

/**
 * The whiteboard topology on the System Map: every roster node with its live state, the valid
 * hand-off edges, a directional pulse on the exact edge of each hand-off, a flash on a node's
 * memory read / write, the GPU-token holder glowing, Finance's shield while sealed and Tony dimmed
 * with a background ring in Away Mode. All of it from `arbiter-state` / `arbiter-handoff`.
 */
export function AgentTopology({ className = "" }: { className?: string }) {
  const snap = useArbiter((s) => s.snap);
  const pulses = useArbiter((s) => s.pulses);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => void useArbiter.getState().start(), []);
  // Re-render once a pulse expires (only while one is alive).
  useEffect(() => {
    const live = pulses.filter((p) => p.at + PULSE_MS > Date.now());
    if (!live.length) return;
    const t = setTimeout(() => setNow(Date.now()), PULSE_MS);
    return () => clearTimeout(t);
  }, [pulses, now]);

  const nodes = useMemo(() => new Map((snap?.nodes ?? []).map((n) => [n.id, n] as const)), [snap?.nodes]);
  const live = pulses.filter((p) => p.at + PULSE_MS > now);
  const liveEdges = new Map<string, { from: string; to: string; kind: string; key: number }>();
  const flashes = new Set<string>();
  for (const p of live) {
    const e = pulseEdge(p);
    if (e) liveEdges.set(edgeKey(e.from, e.to), { ...e, kind: p.kind, key: p.key });
    const f = flashNode(p);
    if (f) flashes.add(f);
  }
  const away = !!snap?.away;

  if (!snap) {
    return <div className={`rounded-[14px] border border-white/10 p-3 text-[12px] text-ink-3 ${className}`}>Compute arbiter: desktop only (waiting for the engine).</div>;
  }
  return (
    <figure className={`rounded-[14px] border border-holo/20 bg-[rgba(4,8,13,0.7)] p-2 ${className}`} aria-label="Agent topology">
      <figcaption className="mb-1 flex items-center gap-2 px-1 text-[11px]">
        <span className="label-caps text-holo">Agent topology</span>
        <span className="text-ink-3">token: {snap.holder ?? "free"}</span>
        {away && <span className="label-caps rounded-full border border-alert/50 px-2 text-alert">Away Mode</span>}
      </figcaption>
      <svg viewBox="0 0 100 62" className="h-auto w-full" role="img" aria-label="Roster nodes and hand-off edges">
        <defs>
          <marker id="arb-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
            <path d="M0,0 L6,3 L0,6 z" className="fill-teal" />
          </marker>
        </defs>
        {EDGES.map(([a, b]) => {
          const pa = LAYOUT[a];
          const pb = LAYOUT[b];
          if (!pa || !pb) return null;
          const k = edgeKey(a, b);
          const hot = liveEdges.get(k);
          const [x1, y1, x2, y2] = hot && hot.from === b ? [pb.x, pb.y, pa.x, pa.y] : [pa.x, pa.y, pb.x, pb.y];
          return (
            <g key={k}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} className="stroke-white/10" strokeWidth={0.35} />
              {hot && (
                <line
                  key={hot.key}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  strokeWidth={0.8}
                  className={`arb-pulse ${hot.kind === "token" ? "stroke-teal" : "stroke-amber"}`}
                  markerEnd="url(#arb-arrow)"
                  strokeDasharray="3 2"
                />
              )}
            </g>
          );
        })}
        {away && LAYOUT.tony && <circle cx={50} cy={31} r={30} className="arb-ring fill-none stroke-alert/25" strokeWidth={0.4} strokeDasharray="1 1.5" />}
        {Object.entries(LAYOUT).map(([id, p]) => {
          const n: ArbiterNode | undefined = nodes.get(id);
          if (!n) return null;
          const look = nodeLook(n, away);
          const flash = flashes.has(id);
          return (
            <g key={id} transform={`translate(${p.x} ${p.y})`} opacity={look.dim && !flash ? 0.55 : 1}>
              <title>{`${n.label}: ${look.label}${n.note ? ` · ${n.note}` : ""}${n.error ? ` · ${n.error}` : ""}\n${n.schedule}`}</title>
              <circle r={4.6} className={`${look.fill} ${look.ring} ${look.pulse ? "arb-node-pulse" : ""} ${flash ? "arb-flash" : ""}`} strokeWidth={0.6} />
              {n.state === "LOCKED_VAULT" && <path d="M-1.6,-1.2 L0,-2.4 L1.6,-1.2 L1.6,0.6 Q0,2.4 -1.6,0.6 Z" className="fill-violet-300/70" />}
              {n.namespace && n.state !== "LOCKED_VAULT" && <circle cx={3.6} cy={-3.4} r={0.9} className={flash ? "fill-amber" : "fill-white/25"} />}
              <text y={7.6} textAnchor="middle" className={`${look.text} text-[2.6px] font-mono uppercase`}>
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>
      <style>{`
        @keyframes arb-dash { to { stroke-dashoffset: -10; } }
        .arb-pulse { animation: arb-dash 0.7s linear 2; }
        @keyframes arb-glow { 0%,100% { stroke-width: .6; } 50% { stroke-width: 1.4; } }
        .arb-node-pulse { animation: arb-glow 1.6s ease-in-out infinite; }
        @keyframes arb-flash-k { from { stroke-width: 1.6; } to { stroke-width: .6; } }
        .arb-flash { animation: arb-flash-k 1.2s ease-out 1; }
        @keyframes arb-spin { to { transform: rotate(360deg); } }
        .arb-ring { transform-origin: 50px 31px; animation: arb-spin 30s linear infinite; }
        @media (prefers-reduced-motion: reduce) { .arb-pulse, .arb-node-pulse, .arb-flash, .arb-ring { animation: none; } }
      `}</style>
    </figure>
  );
}
