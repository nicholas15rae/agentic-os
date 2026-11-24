/**
 * System Map pages 2 + 3 (pure, unit-tested): the domain buses and their colours, how a live
 * arbiter node reads on the surface, the Schematic Flowchart's top-down layout and its 90° traces,
 * which traces a hand-off lights up, and the orbital system's planets.
 *
 * Everything here is static architecture (who sits on which bus, where); every *state* the pages
 * show comes from the live arbiter / introspect / agent_inspect data, never from this file.
 */
import type { ArbiterNode, Handoff } from "@/features/arbiter/api";
import { pulseEdge } from "@/features/arbiter/agent-graph";
import type { SnapAgent, SnapBus, SnapSkill } from "@/lib/platform";

// ── Buses ─────────────────────────────────────────────────────────────────────

export type BusId = "core" | "build" | "media" | "memory" | "vault" | "ops" | "security" | "trading";

export interface BusLook {
  label: string;
  /** Trace colour (hex). */
  color: string;
  /** "r,g,b" for rgba() glows. */
  rgb: string;
}

export const BUSES: Readonly<Record<BusId, BusLook>> = {
  core: { label: "Core routing", color: "#22d3ee", rgb: "34,211,238" },
  build: { label: "Coding / build", color: "#f59e0b", rgb: "245,158,11" },
  media: { label: "Media / edit", color: "#e879f9", rgb: "232,121,249" },
  memory: { label: "RAG / memory", color: "#34d399", rgb: "52,211,153" },
  vault: { label: "Finance vault", color: "#a78bfa", rgb: "167,139,250" },
  ops: { label: "Ops / booking", color: "#60a5fa", rgb: "96,165,250" },
  security: { label: "Security / garbage", color: "#f43f5e", rgb: "244,63,94" },
  trading: { label: "Trading (isolated)", color: "#84cc16", rgb: "132,204,22" },
};

/** The roster (arbiter node ids), Tony first. */
export const ROSTER = ["tony", "prompter", "coder", "designer", "director", "librarian", "finance", "booking", "ops", "bizops", "trading", "observer", "security", "garbage"] as const;
export type RosterId = (typeof ROSTER)[number];

export const NODE_BUS: Readonly<Record<RosterId, BusId>> = {
  tony: "core",
  prompter: "build",
  coder: "build",
  designer: "build",
  director: "media",
  librarian: "memory",
  finance: "vault",
  booking: "ops",
  ops: "ops",
  bizops: "ops",
  trading: "trading",
  observer: "security",
  security: "security",
  garbage: "security",
};

export const NODE_LABEL: Readonly<Record<RosterId, string>> = {
  tony: "Tony",
  prompter: "Prompter",
  coder: "Coder",
  designer: "Designer",
  director: "Director",
  librarian: "Librarian",
  finance: "Financer",
  booking: "Booking Agent",
  ops: "Ops",
  bizops: "Biz Ops",
  trading: "Trading Agent",
  observer: "Observer",
  security: "Security",
  garbage: "Garbage Daemon",
};

export const isRoster = (id: string): id is RosterId => (ROSTER as readonly string[]).includes(id);

/**
 * Nodes off Tony's dispatch tree (arbiter::ISOLATED): no spine trace, only their allowlisted edges.
 * The Trading Agent's one peer is the Financer; its risk gate (the Security Detail) is part of the
 * trading module itself, not the mesh Security agent.
 */
export const ISOLATED: readonly RosterId[] = ["trading"];
export const isIsolated = (id: string): boolean => (ISOLATED as readonly string[]).includes(id);

// ── Surface state ───────────────────────────────────────────────────────────

export type Surface = "ACTIVE" | "IDLE" | "DORMANT" | "SEALED" | "QUEUED" | "ERROR" | "OFFLINE";

/** The one word a node's card / planet shows. `undefined` node = no engine data (OFFLINE). */
export function surfaceState(n: Pick<ArbiterNode, "state" | "configured"> | undefined): Surface {
  if (!n) return "OFFLINE";
  switch (n.state) {
    case "ACTIVE_TOKEN":
    case "ACTIVE":
      return "ACTIVE";
    case "QUEUED":
      return "QUEUED";
    case "LOCKED_VAULT":
      return "SEALED";
    case "ERROR":
      return "ERROR";
    case "DORMANT":
      return n.configured ? "IDLE" : "DORMANT";
  }
}

export const SURFACE_TONE: Readonly<Record<Surface, string>> = {
  ACTIVE: "#5eead4",
  QUEUED: "#fbbf24",
  IDLE: "#94a3b8",
  DORMANT: "#475569",
  SEALED: "#c4b5fd",
  ERROR: "#f87171",
  OFFLINE: "#334155",
};

// ── Introspect joins ───────────────────────────────────────────────────────

/** AnythingLLM role behind a roster node (`SnapAgent.role`; "general" = Tony). */
const INTROSPECT_ROLE: Partial<Record<RosterId, string>> = { tony: "general", prompter: "prompter", coder: "coder", designer: "designer", director: "director", librarian: "librarian", ops: "ops", booking: "booking", finance: "finance" };

export function agentFor(id: RosterId, agents: readonly SnapAgent[] | undefined): SnapAgent | undefined {
  // Biz Ops has one workspace per business (`bizops_<id>`): show the first one's model.
  if (id === "bizops") return agents?.find((a) => a.role === "bizops" || a.slug.startsWith("bizops_"));
  const role = INTROSPECT_ROLE[id];
  return role ? agents?.find((a) => a.role === role || a.slug === role) : undefined;
}

/** "qwen/qwen3.5-9b" → "qwen3.5-9b"; null when unknown. */
export function modelName(a: SnapAgent | undefined): string | null {
  const m = a?.chatModel ?? a?.agentModel ?? null;
  return m ? (m.split("/").pop() ?? m) : null;
}

/** Skills granted to a node (os.json grants, by role / node id; Tony also gets "general"/"tony"). */
export function skillsFor(id: RosterId, items: readonly SnapSkill[] | undefined): SnapSkill[] {
  const names = new Set([id, INTROSPECT_ROLE[id] ?? id, ...(id === "tony" ? ["general", "tony"] : [])].map((s) => s.toLowerCase()));
  return (items ?? []).filter((s) => s.agents.some((a) => names.has(a.toLowerCase())));
}

/** Which MCP / API servers each node reaches (matched against the live bus by id or name). */
export const HOOKUP_HINTS: Readonly<Record<RosterId, readonly string[]>> = {
  tony: ["brave", "search", "spotify", "gmail", "maps", "calendar", "fetch", "time"],
  prompter: ["sequential", "thinking"],
  coder: ["filesystem", "git", "github", "playwright"],
  designer: ["stitch", "figma", "playwright"],
  director: ["media-forge", "media", "ffmpeg"],
  librarian: ["memory", "knowledge", "anythingllm", "filesystem", "documenter"],
  finance: ["market", "trading", "finance"],
  booking: ["n8n", "gmail", "calendar", "instagram"],
  ops: ["n8n", "scheduler", "services"],
  bizops: ["gmail", "calendar", "time", "knowledge"],
  trading: ["ibkr", "trading"],
  observer: ["trace", "telemetry"],
  security: ["security", "bridge"],
  garbage: [],
};

export function hookupsFor(id: RosterId, bus: readonly SnapBus[] | undefined): SnapBus[] {
  const hints = HOOKUP_HINTS[id];
  if (!hints.length) return [];
  return (bus ?? []).filter((b) => {
    const key = `${b.id} ${b.name}`.toLowerCase();
    return hints.some((h) => key.includes(h));
  });
}

/** Filesystem / vault boundary each node runs under (the engine's enforced rules, as text). */
export const BOUNDARY: Readonly<Record<RosterId, string>> = {
  tony: "Foreground: reads every namespace; writes only `tony`; dispatches packets (asks first in Ask mode)",
  prompter: "Build circle: read/write `build_circle`; no filesystem writes",
  coder: "Write: staging/<slug> only (sandboxed output folder); read `build_circle`",
  designer: "Write: staging/<slug> assets only; read `build_circle`",
  director: "Media projects: writes new renders / exports only; never modifies original raw footage or photos",
  librarian: "Read-only over every non-vault namespace + cold archives; writes `librarian`",
  finance: "SEALED vault: AES-GCM ledger, opens only on your explicit unlock; never in shared memory. The Finance agent answers from one ledger's rows; its workspace holds no documents",
  booking: "Outbound via the n8n webhook only; writes `booking`",
  ops: "AnythingLLM workspace (on demand); no direct filesystem access",
  bizops: "One business per turn: reads / writes only memory/ops/<business> (jailed), RAG only its bizops_<id> workspace; money only through the approved Finance hand-off",
  trading:
    "Isolated: talks only to the Financer. Proposes OrderIntents; every one passes the Security Detail (deterministic risk + sizing gate) before the paper bridge at 127.0.0.1:7497 (localhost-only)",
  observer: "Read-only audit of hand-off integrity; writes `observer`",
  security: "Read-only injection / boundary scan of new hand-offs; writes `security` dumps",
  garbage: "Delete inside its allowlist only (dumps, stale memory, staging temp); never the vault",
};

// ── Hand-off → traces ──────────────────────────────────────────────────────

export const pairKey = (a: string, b: string) => [a, b].sort().join("~");

/**
 * The traces a hand-off lights on the schematic: Tony ↔ X lights X's bus trace; two siblings in
 * the same column light their side link; anything else lights both nodes' traces (they meet on
 * the spine). Memory reads / writes light the node's RAG drop. Pure.
 */
export function tracesFor(h: Pick<Handoff, "from" | "to" | "kind">): string[] {
  if (h.kind === "memory_read" || h.kind === "memory_write") {
    const who = h.kind === "memory_read" ? h.to : h.from;
    return isRoster(who) ? [`rag:${who}`] : [];
  }
  const e = pulseEdge(h);
  if (!e || !isRoster(e.from) || !isRoster(e.to)) return [];
  if (e.from === "tony") return [`bus:${e.to}`];
  if (e.to === "tony") return [`bus:${e.from}`];
  const a = FLOW_NODES[e.from];
  const b = FLOW_NODES[e.to];
  if (a.col === b.col && a.col !== "bottom") return [`link:${pairKey(e.from, e.to)}`];
  return [`bus:${e.from}`, `bus:${e.to}`];
}

/** Live traces: trace id → the newest hand-off lighting it (within `windowMs`). Pure. */
export function liveTraces<H extends Pick<Handoff, "from" | "to" | "kind" | "at">>(pulses: readonly H[], now: number, windowMs: number): Map<string, H> {
  const out = new Map<string, H>();
  for (const p of pulses) {
    if (now - p.at > windowMs) continue;
    for (const t of tracesFor(p)) out.set(t, p);
  }
  return out;
}

// ── Schematic layout (viewBox units) ───────────────────────────────────────

export const FLOW_W = 1600;
export const FLOW_H = 1410;
export const SPINE_X = 800;
export const CARD_W = 300;
export const CARD_H = 156;

export const USER_BOX = { x: SPINE_X, y: 70, w: 240, h: 58 };
export const TONY_BOX = { x: SPINE_X, y: 230, w: 300, h: 128 };
/** Where the bottom (security) row's horizontal bus runs. */
export const BOTTOM_BUS_Y = 1160;

export interface FlowNode {
  /** Card centre. */
  x: number;
  y: number;
  col: "left" | "right" | "bottom";
}

export const FLOW_NODES: Readonly<Record<Exclude<RosterId, "tony">, FlowNode>> = {
  prompter: { x: 290, y: 400, col: "left" },
  coder: { x: 290, y: 570, col: "left" },
  designer: { x: 290, y: 740, col: "left" },
  director: { x: 290, y: 910, col: "left" },
  librarian: { x: 1310, y: 400, col: "right" },
  finance: { x: 1310, y: 570, col: "right" },
  booking: { x: 1310, y: 740, col: "right" },
  ops: { x: 1310, y: 910, col: "right" },
  bizops: { x: 1310, y: 1080, col: "right" },
  // Off Tony's spine (isolated): under Biz Ops, joined only to the Financer by a side link.
  trading: { x: 1310, y: 1250, col: "right" },
  // The bottom row sits left of the Trading card.
  observer: { x: 360, y: 1280, col: "bottom" },
  security: { x: 690, y: 1280, col: "bottom" },
  garbage: { x: 1000, y: 1280, col: "bottom" },
};

/** Each bus drops off the spine on its own lane, so parallel traces never overlap. */
export const BUS_LANE: Readonly<Record<BusId, number>> = { core: 0, build: -36, media: -18, memory: 30, vault: 54, ops: 78, security: 0, trading: 0 };

/** The 90°-routed trace from Tony's spine to a node's card (SVG path). Pure. */
export function busPath(id: Exclude<RosterId, "tony">): string {
  const n = FLOW_NODES[id];
  const lane = SPINE_X + BUS_LANE[NODE_BUS[id]];
  const top = TONY_BOX.y + TONY_BOX.h / 2;
  if (n.col === "bottom") return `M ${SPINE_X} ${top} V ${BOTTOM_BUS_Y} H ${n.x} V ${n.y - CARD_H / 2}`;
  const edge = n.col === "left" ? n.x + CARD_W / 2 : n.x - CARD_W / 2;
  return `M ${lane} ${top} V ${n.y} H ${edge}`;
}

/** A side link between two siblings in one column, routed outside the cards. Pure. */
export function linkPath(a: Exclude<RosterId, "tony">, b: Exclude<RosterId, "tony">): string {
  const p = FLOW_NODES[a];
  const q = FLOW_NODES[b];
  const out = p.col === "left" ? p.x - CARD_W / 2 - 34 : p.x + CARD_W / 2 + 34;
  const edge = p.col === "left" ? p.x - CARD_W / 2 : p.x + CARD_W / 2;
  return `M ${edge} ${p.y - 20} H ${out} V ${q.y - 20} H ${edge}`;
}

/** Sibling links worth drawing (valid arbiter edges inside one column). */
export function siblingLinks(edges: readonly (readonly [string, string])[]): [Exclude<RosterId, "tony">, Exclude<RosterId, "tony">][] {
  const seen = new Set<string>();
  const out: [Exclude<RosterId, "tony">, Exclude<RosterId, "tony">][] = [];
  for (const [a, b] of edges) {
    if (a === "tony" || b === "tony" || !isRoster(a) || !isRoster(b)) continue;
    const p = FLOW_NODES[a as Exclude<RosterId, "tony">];
    const q = FLOW_NODES[b as Exclude<RosterId, "tony">];
    if (p.col !== q.col || p.col === "bottom") continue;
    const k = pairKey(a, b);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([a as Exclude<RosterId, "tony">, b as Exclude<RosterId, "tony">]);
  }
  return out;
}

/** Clamp a pan/zoom view so the schematic never leaves the screen entirely. Pure. */
export function clampView(v: { x: number; y: number; k: number }): { x: number; y: number; k: number } {
  const k = Math.min(3, Math.max(0.3, v.k));
  const lim = (n: number, size: number) => Math.min(size * 0.8, Math.max(-size * k * 0.8, n));
  return { k, x: lim(v.x, FLOW_W), y: lim(v.y, FLOW_H) };
}

// ── Orbital system ─────────────────────────────────────────────────────────

export interface Orbit {
  /** Orbit radius (world units); 0 = the central star. */
  radius: number;
  /** Radians per second. */
  speed: number;
  phase: number;
  /** Orbit-plane tilt (radians about X). */
  tilt: number;
  size: number;
  /** Surface palette: [deep, mid, light] (hex). */
  palette: readonly [string, string, string];
  /** Atmosphere rim colour (hex). */
  atmosphere: string;
  kind: "star" | "planet" | "vault" | "sentinel";
}

export const ORBITS: Readonly<Record<RosterId, Orbit>> = {
  tony: { radius: 0, speed: 0, phase: 0, tilt: 0, size: 2.6, palette: ["#ff7a18", "#ffb347", "#fff1c1"], atmosphere: "#ffb347", kind: "star" },
  prompter: { radius: 7, speed: 0.07, phase: 0.4, tilt: 0.05, size: 0.62, palette: ["#4a2a08", "#c27a2c", "#f5d29a"], atmosphere: "#fbbf24", kind: "planet" },
  coder: { radius: 9.5, speed: 0.055, phase: 2.2, tilt: -0.04, size: 0.78, palette: ["#2b1a0c", "#a0522d", "#f4a261"], atmosphere: "#f59e0b", kind: "planet" },
  designer: { radius: 12, speed: 0.045, phase: 4.1, tilt: 0.06, size: 0.7, palette: ["#3b0d2e", "#c2417d", "#ffb4d2"], atmosphere: "#f472b6", kind: "planet" },
  director: { radius: 13.5, speed: 0.04, phase: 0.2, tilt: -0.03, size: 0.64, palette: ["#2a0a2e", "#a3389a", "#f5c2ec"], atmosphere: "#e879f9", kind: "planet" },
  librarian: { radius: 15, speed: 0.036, phase: 1.1, tilt: -0.07, size: 0.95, palette: ["#062b22", "#1f8a6b", "#a7f3d0"], atmosphere: "#34d399", kind: "planet" },
  ops: { radius: 18, speed: 0.03, phase: 5.3, tilt: 0.05, size: 0.74, palette: ["#0b1f3a", "#2f6fb4", "#bfdbfe"], atmosphere: "#60a5fa", kind: "planet" },
  bizops: { radius: 19.5, speed: 0.027, phase: 1.7, tilt: -0.02, size: 0.72, palette: ["#062a2e", "#1b8a96", "#a5f3fc"], atmosphere: "#22d3ee", kind: "planet" },
  booking: { radius: 21, speed: 0.025, phase: 3.0, tilt: -0.05, size: 0.66, palette: ["#2a2410", "#8f7a3a", "#e9dca2"], atmosphere: "#facc15", kind: "planet" },
  observer: { radius: 24, speed: 0.021, phase: 0.9, tilt: 0.08, size: 0.6, palette: ["#1d2130", "#5b6378", "#cfd6e6"], atmosphere: "#93c5fd", kind: "planet" },
  finance: { radius: 27.5, speed: 0.018, phase: 2.6, tilt: -0.06, size: 1.05, palette: ["#1e0b3a", "#6d3fc4", "#d8c4ff"], atmosphere: "#a78bfa", kind: "vault" },
  // Orbits just outside the Finance vault (its only peer).
  trading: { radius: 29.5, speed: 0.019, phase: 3.1, tilt: -0.05, size: 0.7, palette: ["#1a2e05", "#4d7c0f", "#d9f99d"], atmosphere: "#84cc16", kind: "planet" },
  security: { radius: 32, speed: -0.016, phase: 4.6, tilt: 0.12, size: 0.38, palette: ["#2a0a10", "#9f1239", "#fda4af"], atmosphere: "#f43f5e", kind: "sentinel" },
  garbage: { radius: 32, speed: -0.016, phase: 4.6 + Math.PI, tilt: 0.12, size: 0.34, palette: ["#1f0f0f", "#7f1d1d", "#fca5a5"], atmosphere: "#ef4444", kind: "sentinel" },
};

/** World position of a body at time `t` (seconds). The orbit is a slightly flattened ellipse. Pure. */
export function orbitPos(o: Orbit, t: number): [number, number, number] {
  if (o.radius === 0) return [0, 0, 0];
  const a = o.phase + o.speed * t;
  const x = Math.cos(a) * o.radius;
  const z = Math.sin(a) * o.radius * 0.82;
  return [x, -z * Math.sin(o.tilt), z * Math.cos(o.tilt)];
}

/** Moons: RAG store, Memory Module, tool hookups — sized by the live counts (log scale). Pure. */
export function moonSize(count: number | null | undefined, base: number): number {
  return base * (0.55 + 0.25 * Math.log10(1 + Math.max(0, count ?? 0)));
}
