import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type WheelEvent as RWheelEvent } from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import { usePoll } from "@/lib/use-poll";
import { isTauri } from "@/lib/platform";
import { useArbiter } from "@/features/arbiter/arbiter-store";
import { shortModel, useTradingAgent } from "@/features/trading/useTradingAgent";
import type { AgentView } from "@/features/trading/AgentPanel.contract";
import { useMemmapData } from "@/features/memmap/use-memmap-data";
import type { ArbiterNode, MemoryRow } from "@/features/arbiter/api";
import { useSysMap, type InspectFocus } from "./sysmap-store";
import {
  agentFor,
  BUSES,
  busPath,
  CARD_H,
  CARD_W,
  clampView,
  FLOW_H,
  FLOW_NODES,
  isIsolated,
  FLOW_W,
  hookupsFor,
  linkPath,
  liveTraces,
  modelName,
  NODE_BUS,
  NODE_LABEL,
  pairKey,
  ROSTER,
  siblingLinks,
  skillsFor,
  SPINE_X,
  surfaceState,
  SURFACE_TONE,
  TONY_BOX,
  USER_BOX,
  type RosterId,
} from "./model";
import { EDGES } from "@/features/arbiter/agent-graph";
import { SurfaceBackdropLayer, useBackdropActive } from "@/features/wallpaper/SurfaceBackdropLayer";
import { BackdropHudToggle } from "@/features/wallpaper/BackdropHudToggle";
import { DiagnosticBadges, DiagnosticConduits } from "./DiagnosticOverlay";
import { DiagnosticPanel } from "./DiagnosticPanel";

/** How long a hand-off keeps its trace lit (CSS dash animation only; no rAF loop). */
const LIT_MS = 1600;
/** Memory tiers + node states while this page is open (visible-only poll). */
const POLL_MS = 3000;

type View = { x: number; y: number; k: number };
const FIT: View = { x: 0, y: 0, k: 1 };

const NS_OF: Partial<Record<RosterId, string>> = { tony: "tony", prompter: "build_circle", coder: "build_circle", designer: "build_circle", director: "director", librarian: "librarian", booking: "booking", security: "security", observer: "observer" };

function Port({ x, y, color }: { x: number; y: number; color: string }) {
  return <circle cx={x} cy={y} r={4} fill="#05080d" stroke={color} strokeWidth={1.5} />;
}

/** One sub-box under an agent card (RAG / MEMORY / TOOLS), clickable into the inspector. */
function SubBox({ x, y, w, label, value, color, onClick, lit }: { x: number; y: number; w: number; label: string; value: string; color: string; onClick: () => void; lit?: boolean }) {
  return (
    <g className="sysmap-hit" onClick={(e) => (e.stopPropagation(), onClick())} role="button" aria-label={`${label}: ${value}`}>
      <rect x={x} y={y} width={w} height={34} rx={5} fill={lit ? `${color}22` : "rgba(255,255,255,0.025)"} stroke={lit ? color : "rgba(255,255,255,0.12)"} strokeWidth={lit ? 1.4 : 1} />
      <text x={x + 8} y={y + 13} className="sysmap-mono" fontSize={8.5} fill={color} letterSpacing={1.2}>
        {label}
      </text>
      <text x={x + 8} y={y + 27} className="sysmap-mono" fontSize={10.5} fill="#cbd5e1">
        {value}
      </text>
    </g>
  );
}

function AgentCard({
  id,
  node,
  mem,
  model,
  tools,
  skills,
  vaultOpen,
  ragLit,
  open,
  trading,
}: {
  trading?: AgentView | null;
  id: Exclude<RosterId, "tony">;
  node: ArbiterNode | undefined;
  mem: MemoryRow | undefined;
  model: string | null;
  tools: number;
  skills: number;
  vaultOpen: boolean;
  ragLit: boolean;
  open: (f: InspectFocus) => void;
}) {
  const p = FLOW_NODES[id];
  const bus = BUSES[NODE_BUS[id]];
  // The trading node's state comes from the agent itself (the arbiter only sees its hand-offs):
  // running → ACTIVE, switched on → IDLE (armed), off → DORMANT.
  const s = id === "trading" && trading ? (trading.runs[0]?.status === "running" ? "ACTIVE" : trading.enabled ? "IDLE" : "DORMANT") : surfaceState(node);
  const tone = SURFACE_TONE[s];
  const x = p.x - CARD_W / 2;
  const y = p.y - CARD_H / 2;
  const hot = s === "ACTIVE";
  const rag = id === "finance" ? (vaultOpen ? "vault · open" : "vault · sealed") : id === "trading" ? "trading_rag" : mem ? `${mem.active} live` : id === "garbage" ? "stateless" : "—";
  const memory = id === "finance" ? "encrypted" : mem ? `${mem.activeKb}KB · ${mem.archived} disk` : "—";
  const sub = (CARD_W - 32) / 3;
  return (
    <g className="sysmap-hit" onClick={() => open("rag")} role="button" aria-label={`${NODE_LABEL[id]}: ${s}`}>
      {hot && <rect x={x - 4} y={y - 4} width={CARD_W + 8} height={CARD_H + 8} rx={12} fill="none" stroke={bus.color} strokeOpacity={0.35} className="sysmap-breathe" />}
      <rect x={x} y={y} width={CARD_W} height={CARD_H} rx={9} fill="rgba(6,9,15,0.94)" stroke={hot ? bus.color : `rgba(${bus.rgb},0.28)`} strokeWidth={hot ? 1.5 : 1} style={{ filter: `drop-shadow(0 0 10px rgba(${bus.rgb},0.12))` }} />
      <rect x={x} y={y + 10} width={3} height={30} fill={bus.color} />
      <text x={x + 14} y={y + 24} fontSize={15} fontWeight={600} fill="#f1f5f9">
        {NODE_LABEL[id]}
      </text>
      <g transform={`translate(${x + CARD_W - 12}, ${y + 20})`}>
        <circle cx={-6} cy={-4} r={3.5} fill={tone} className={hot ? "sysmap-blink" : undefined} />
        <text x={-14} y={0} textAnchor="end" className="sysmap-mono" fontSize={9.5} fill={tone} letterSpacing={1.4}>
          {id === "finance" && !vaultOpen ? "SEALED" : s}
        </text>
      </g>
      <text x={x + 14} y={y + 42} className="sysmap-mono" fontSize={9.5} fill="#64748b">
        {id === "trading" ? "LOCAL LLM" : (node?.compute ?? "—").toUpperCase()} · {model ?? (node?.compute === "cpu" ? "deterministic" : "model —")}
      </text>
      <text x={x + 14} y={y + 58} className="sysmap-mono" fontSize={9} fill="#475569">
        runs {node?.runs ?? 0} · {skills} skill{skills === 1 ? "" : "s"}
        {node?.error ? ` · ${node.error.slice(0, 24)}` : ""}
      </text>
      {id === "trading" && (
        // The Security Detail is the trading module's own deterministic gate (not the mesh Security agent).
        <g aria-label="Security Detail gate: every proposal passes it before the IBKR paper bridge (localhost only)">
          <rect x={x + 8} y={y + 66} width={CARD_W - 16} height={18} rx={4} fill={`rgba(${bus.rgb},0.08)`} stroke={`rgba(${bus.rgb},0.45)`} strokeDasharray="2 2" />
          {/* textLength pins the line to the strip: it can never spill past the card. */}
          <text x={x + 16} y={y + 79} className="sysmap-mono" fontSize={8.5} fill={bus.color} textLength={CARD_W - 32} lengthAdjust="spacingAndGlyphs">
            ⛨ SECURITY DETAIL → IBKR PAPER · 127.0.0.1:7497 only
          </text>
        </g>
      )}
      <SubBox x={x + 8} y={y + CARD_H - 46} w={sub} label="RAG" value={rag} color={BUSES.memory.color} lit={ragLit} onClick={() => open("rag")} />
      <SubBox x={x + 16 + sub} y={y + CARD_H - 46} w={sub} label="MEMORY" value={memory} color="#38bdf8" onClick={() => open("memory")} />
      <SubBox x={x + 24 + 2 * sub} y={y + CARD_H - 46} w={sub} label="TOOLS" value={`${tools} MCP`} color="#fbbf24" onClick={() => open("caps")} />
    </g>
  );
}

/**
 * Page 2 · Schematic Flowchart: a top-down circuit board. USER // COMMAND feeds TONY, whose
 * vertical spine branches on colour-coded 90° buses to every specialist; each card carries its
 * live state, model and RAG / Memory / Tools sub-boxes. A trace lights (directional dash) only
 * when a real hand-off crosses it. Pan by dragging, zoom with the wheel; click anything to open
 * the Deep Inspector. SVG + CSS only: no animation loop, nothing runs while idle.
 */
export function SchematicFlowchart() {
  const snap = useArbiter((s) => s.snap);
  const pulses = useArbiter((s) => s.pulses);
  const open = useSysMap((s) => s.open);
  const inspecting = useSysMap((s) => s.inspect);
  const { snap: sys } = useMemmapData();
  const { view: trading } = useTradingAgent();
  const backdrop = useBackdropActive("flowchart");
  useEffect(() => void useArbiter.getState().start(), []);
  usePoll(() => (isTauri() ? useArbiter.getState().refresh() : Promise.resolve()), POLL_MS);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!pulses.some((p) => p.at + LIT_MS > Date.now())) return;
    const t = setTimeout(() => setNow(Date.now()), 250);
    return () => clearTimeout(t);
  }, [pulses, now]);
  const lit = useMemo(() => liveTraces(pulses, now, LIT_MS), [pulses, now]);

  const nodes = useMemo(() => new Map((snap?.nodes ?? []).map((n) => [n.id, n] as const)), [snap?.nodes]);
  const mems = useMemo(() => new Map((snap?.memory ?? []).map((m) => [m.namespace, m] as const)), [snap?.memory]);
  const links = useMemo(() => siblingLinks(snap?.edges ?? EDGES), [snap?.edges]);
  const vaultOpen = !!snap?.vaultOpen;

  // ── pan & zoom ──
  const [view, setView] = useState<View>(FIT);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const toLocal = (cx: number, cy: number) => {
    const r = svg.current!.getBoundingClientRect();
    const s = Math.min(r.width / FLOW_W, r.height / FLOW_H);
    const ox = (r.width - FLOW_W * s) / 2;
    const oy = (r.height - FLOW_H * s) / 2;
    return { x: (cx - r.left - ox) / s, y: (cy - r.top - oy) / s };
  };
  const onWheel = (e: RWheelEvent<SVGSVGElement>) => {
    const p = toLocal(e.clientX, e.clientY);
    setView((v) => {
      const k = clampView({ ...v, k: v.k * Math.exp(-e.deltaY * 0.0012) }).k;
      // Keep the point under the cursor fixed.
      return clampView({ k, x: p.x - ((p.x - v.x) * k) / v.k, y: p.y - ((p.y - v.y) * k) / v.k });
    });
  };
  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const r = svg.current!.getBoundingClientRect();
    const s = Math.min(r.width / FLOW_W, r.height / FLOW_H);
    const dx = (e.clientX - d.x) / s;
    const dy = (e.clientY - d.y) / s;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) svg.current!.setPointerCapture(e.pointerId);
    d.moved = true;
    setView((v) => clampView({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const onUp = (e: RPointerEvent<SVGSVGElement>) => {
    if (drag.current?.moved && svg.current?.hasPointerCapture(e.pointerId)) svg.current.releasePointerCapture(e.pointerId);
    // A drag never counts as a click on the card under it.
    if (drag.current?.moved) {
      const stop = (ev: Event) => (ev.stopPropagation(), window.removeEventListener("click", stop, true));
      window.addEventListener("click", stop, true);
      setTimeout(() => window.removeEventListener("click", stop, true), 0);
    }
    drag.current = null;
  };
  const zoom = (f: number) => setView((v) => clampView({ k: v.k * f, x: FLOW_W / 2 - ((FLOW_W / 2 - v.x) * v.k * f) / v.k, y: FLOW_H / 2 - ((FLOW_H / 2 - v.y) * v.k * f) / v.k }));

  const tony = nodes.get("tony");
  const tonyState = surfaceState(tony);
  const top = TONY_BOX.y + TONY_BOX.h / 2;

  return (
    <div className="sysmap-schematic relative h-full w-full overflow-hidden" data-inspecting={inspecting ? "" : undefined}>
      {/* Custom rolling backdrop (z-0, no pointer events); absent = Clean Minimal. */}
      <SurfaceBackdropLayer surface="flowchart" />
      <svg
        ref={svg}
        viewBox={`0 0 ${FLOW_W} ${FLOW_H}`}
        preserveAspectRatio="xMidYMid meet"
        className="relative z-10 h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
        onWheel={onWheel}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        role="img"
        aria-label="Schematic flowchart of the agent architecture"
      >
        <defs>
          <pattern id="sm-grid" width={40} height={40} patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(148,163,184,0.05)" strokeWidth={1} />
          </pattern>
          <radialGradient id="sm-glow" cx="50%" cy="22%" r="60%">
            <stop offset="0%" stopColor="rgba(34,211,238,0.10)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0)" />
          </radialGradient>
          {Object.entries(BUSES).map(([k, b]) => (
            <marker key={k} id={`sm-arrow-${k}`} viewBox="0 0 8 8" refX={6} refY={4} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill={b.color} />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          <rect x={-FLOW_W} y={-FLOW_H} width={FLOW_W * 3} height={FLOW_H * 3} fill="url(#sm-grid)" />
          {!backdrop && <rect width={FLOW_W} height={FLOW_H} fill="url(#sm-glow)" />}

          {/* Legend */}
          <g transform="translate(40 40)" className="sysmap-mono">
            <text fontSize={13} fill="#e2e8f0" letterSpacing={3}>
              AGENTIC OS // SCHEMATIC
            </text>
            {Object.entries(BUSES).map(([k, b], i) => (
              <g key={k} transform={`translate(0 ${24 + i * 17})`}>
                <line x1={0} y1={-4} x2={26} y2={-4} stroke={b.color} strokeWidth={2} />
                <text x={34} y={0} fontSize={10} fill="#94a3b8" letterSpacing={1}>
                  {b.label.toUpperCase()}
                </text>
              </g>
            ))}
            <text y={24 + Object.keys(BUSES).length * 17 + 6} fontSize={9.5} fill="#475569">
              traces light only on real hand-offs
            </text>
          </g>

          {/* USER → TONY */}
          <line x1={SPINE_X} y1={USER_BOX.y + USER_BOX.h / 2} x2={SPINE_X} y2={TONY_BOX.y - TONY_BOX.h / 2} stroke={BUSES.core.color} strokeWidth={2} markerEnd="url(#sm-arrow-core)" />
          <g>
            <rect x={USER_BOX.x - USER_BOX.w / 2} y={USER_BOX.y - USER_BOX.h / 2} width={USER_BOX.w} height={USER_BOX.h} rx={8} fill="rgba(6,9,15,0.96)" stroke="rgba(226,232,240,0.5)" />
            <text x={USER_BOX.x} y={USER_BOX.y + 5} textAnchor="middle" className="sysmap-mono" fontSize={14} fill="#f8fafc" letterSpacing={3}>
              USER // COMMAND
            </text>
          </g>

          {/* Buses (base layer, then lit layer) */}
          {ROSTER.filter((r): r is Exclude<RosterId, "tony"> => r !== "tony" && !isIsolated(r)).map((id) => {
            const b = BUSES[NODE_BUS[id]];
            const hot = lit.get(`bus:${id}`);
            const d = busPath(id);
            const inbound = hot && hot.to === "tony";
            return (
              <g key={id}>
                <path d={d} fill="none" stroke={b.color} strokeOpacity={0.28} strokeWidth={1.6} />
                {hot && <path key={`${hot.at}-${hot.from}`} d={d} fill="none" stroke={b.color} strokeWidth={3} className={inbound ? "sysmap-flow-rev" : "sysmap-flow"} style={{ filter: `drop-shadow(0 0 6px rgba(${b.rgb},0.9))` }} />}
              </g>
            );
          })}
          {links.map(([a, b]) => {
            const d = linkPath(a, b);
            const k = pairKey(a, b);
            const hot = lit.get(`link:${k}`);
            const c = BUSES[NODE_BUS[a]];
            return (
              <g key={k}>
                <path d={d} fill="none" stroke={c.color} strokeOpacity={0.18} strokeWidth={1.2} strokeDasharray="3 4" />
                {hot && <path key={hot.at} d={d} fill="none" stroke={c.color} strokeWidth={2.6} className={hot.from === a ? "sysmap-flow" : "sysmap-flow-rev"} />}
              </g>
            );
          })}
          {links.some(([a, b]) => pairKey(a, b) === pairKey("finance", "trading")) && (
            <text
              x={FLOW_NODES.trading.x + CARD_W / 2 + 48}
              y={(FLOW_NODES.finance.y + FLOW_NODES.trading.y) / 2}
              transform={`rotate(90 ${FLOW_NODES.trading.x + CARD_W / 2 + 48} ${(FLOW_NODES.finance.y + FLOW_NODES.trading.y) / 2})`}
              textAnchor="middle"
              className="sysmap-mono"
              fontSize={9}
              fill={BUSES.trading.color}
              letterSpacing={2}
            >
              FINANCER-ONLY LINK
            </text>
          )}
          {/* Bus taps on the spine */}
          {ROSTER.filter((r): r is Exclude<RosterId, "tony"> => r !== "tony" && !isIsolated(r) && FLOW_NODES[r as Exclude<RosterId, "tony">].col !== "bottom").map((id) => {
            const n = FLOW_NODES[id];
            const edge = n.col === "left" ? n.x + CARD_W / 2 : n.x - CARD_W / 2;
            return <Port key={id} x={edge} y={n.y} color={BUSES[NODE_BUS[id]].color} />;
          })}

          {/* Diagnostic probe packets on their conduits (under the cards) */}
          <DiagnosticConduits />

          {/* TONY — the orchestrator / spine head */}
          <g className="sysmap-hit" onClick={() => open("tony")} role="button" aria-label={`Tony: ${tonyState}`}>
            {tonyState === "ACTIVE" && <rect x={TONY_BOX.x - TONY_BOX.w / 2 - 6} y={TONY_BOX.y - TONY_BOX.h / 2 - 6} width={TONY_BOX.w + 12} height={TONY_BOX.h + 12} rx={14} fill="none" stroke={BUSES.core.color} strokeOpacity={0.4} className="sysmap-breathe" />}
            <rect x={TONY_BOX.x - TONY_BOX.w / 2} y={TONY_BOX.y - TONY_BOX.h / 2} width={TONY_BOX.w} height={TONY_BOX.h} rx={10} fill="rgba(5,12,18,0.98)" stroke={BUSES.core.color} strokeWidth={1.6} />
            <text x={TONY_BOX.x} y={TONY_BOX.y - 28} textAnchor="middle" fontSize={22} fontWeight={700} fill="#f8fafc" letterSpacing={4}>
              TONY
            </text>
            <text x={TONY_BOX.x} y={TONY_BOX.y - 8} textAnchor="middle" className="sysmap-mono" fontSize={10} fill="#67e8f9" letterSpacing={2}>
              ORCHESTRATOR · {snap?.away ? "AWAY MODE" : tonyState}
            </text>
            <text x={TONY_BOX.x} y={TONY_BOX.y + 10} textAnchor="middle" className="sysmap-mono" fontSize={10} fill="#64748b">
              {modelName(agentFor("tony", sys?.agents)) ?? "model —"} · token {snap?.holder ?? "free"}
            </text>
            <SubBox x={TONY_BOX.x - 138} y={TONY_BOX.y + 22} w={88} label="RAG" value={mems.get("tony") ? `${mems.get("tony")!.active} live` : "—"} color={BUSES.memory.color} lit={lit.has("rag:tony")} onClick={() => open("tony", "rag")} />
            <SubBox x={TONY_BOX.x - 44} y={TONY_BOX.y + 22} w={88} label="MEMORY" value={mems.get("tony") ? `${mems.get("tony")!.archived} disk` : "—"} color="#38bdf8" onClick={() => open("tony", "memory")} />
            <SubBox x={TONY_BOX.x + 50} y={TONY_BOX.y + 22} w={88} label="TOOLS" value={`${hookupsFor("tony", sys?.bus).length} MCP`} color="#fbbf24" onClick={() => open("tony", "caps")} />
          </g>
          <Port x={SPINE_X} y={top} color={BUSES.core.color} />

          {/* Specialists */}
          {ROSTER.filter((r): r is Exclude<RosterId, "tony"> => r !== "tony").map((id) => {
            const ns = NS_OF[id];
            return (
              <AgentCard
                key={id}
                id={id}
                node={nodes.get(id)}
                mem={ns ? mems.get(ns) : undefined}
                model={id === "trading" ? shortModel(trading?.config.model) : modelName(agentFor(id, sys?.agents))}
                tools={hookupsFor(id, sys?.bus).length}
                skills={skillsFor(id, sys?.skills.items).length}
                vaultOpen={vaultOpen}
                ragLit={lit.has(`rag:${id}`)}
                open={(f) => open(id, f)}
                trading={id === "trading" ? trading : undefined}
              />
            );
          })}

          {/* Diagnostic health rings + RTT badges (over the cards) */}
          <DiagnosticBadges />
        </g>
      </svg>
      <DiagnosticPanel />

      {!snap && (
        <p className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full border border-white/10 bg-black/60 px-3 py-1 fs-11 text-ink-3">
          {isTauri() ? "Waiting for the engine's first arbiter snapshot…" : "Live states need the desktop engine — showing the wiring only."}
        </p>
      )}
      <div className="absolute bottom-3 left-3 z-20 flex gap-1">
        <button type="button" onClick={() => zoom(1.25)} className="sysmap-ctl" aria-label="Zoom in">
          <Plus size={13} />
        </button>
        <button type="button" onClick={() => zoom(0.8)} className="sysmap-ctl" aria-label="Zoom out">
          <Minus size={13} />
        </button>
        <button type="button" onClick={() => setView(FIT)} className="sysmap-ctl" aria-label="Fit to screen" title="Fit">
          <Maximize size={13} />
        </button>
        <BackdropHudToggle surface="flowchart" />
      </div>
    </div>
  );
}
