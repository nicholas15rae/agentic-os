/**
 * The whiteboard topology (pure, unit-tested): node positions, valid hand-off edges, how each
 * `NodeState` looks, and which edge a hand-off pulses. Positions are in a 0–100 × 0–60 viewBox.
 */
import type { ArbiterNode, Handoff, NodeState } from "./api";

export interface Pos {
  x: number;
  y: number;
}

/** Tony centre-left; the Build Circle as a triangle; Director below Tony; Librarian between; scripts and vault around. */
export const LAYOUT: Readonly<Record<string, Pos>> = {
  tony: { x: 14, y: 30 },
  prompter: { x: 44, y: 12 },
  coder: { x: 62, y: 30 },
  designer: { x: 44, y: 48 },
  director: { x: 28, y: 42 },
  librarian: { x: 82, y: 14 },
  ops: { x: 82, y: 46 },
  booking: { x: 14, y: 6 },
  observer: { x: 14, y: 54 },
  security: { x: 30, y: 57 },
  garbage: { x: 58, y: 57 },
  finance: { x: 92, y: 30 },
  bizops: { x: 92, y: 50 },
};

/** Valid hand-off paths (mirrors `arbiter::EDGES`). */
export const EDGES: readonly [string, string][] = [
  ["tony", "prompter"],
  ["prompter", "coder"],
  ["coder", "designer"],
  ["designer", "prompter"],
  ["tony", "librarian"],
  ["prompter", "librarian"],
  ["coder", "librarian"],
  ["designer", "librarian"],
  ["tony", "booking"],
  ["booking", "tony"],
  ["tony", "director"],
  ["director", "tony"],
  ["director", "librarian"],
  ["security", "garbage"],
  ["observer", "security"],
  ["tony", "finance"],
  ["finance", "librarian"],
  ["tony", "ops"],
  ["observer", "tony"],
  ["tony", "bizops"],
  ["bizops", "tony"],
  ["bizops", "finance"],
];

export const edgeKey = (a: string, b: string) => [a, b].sort().join("~");

export interface NodeLook {
  ring: string;
  fill: string;
  text: string;
  pulse: boolean;
  dim: boolean;
  label: string;
}

/** How a node state reads on the map (Away Mode dims Tony and rings the background). */
export function nodeLook(n: Pick<ArbiterNode, "id" | "state" | "configured">, away: boolean): NodeLook {
  const base: Record<NodeState, NodeLook> = {
    DORMANT: { ring: "stroke-white/15", fill: "fill-[rgba(11,13,17,0.9)]", text: "fill-ink-3", pulse: false, dim: true, label: "dormant" },
    QUEUED: { ring: "stroke-amber/70", fill: "fill-amber/10", text: "fill-amber-light", pulse: false, dim: false, label: "queued" },
    ACTIVE_TOKEN: { ring: "stroke-teal", fill: "fill-teal/25", text: "fill-teal", pulse: true, dim: false, label: "holds the GPU token" },
    ACTIVE: { ring: "stroke-volt", fill: "fill-volt/15", text: "fill-volt", pulse: true, dim: false, label: "running (CPU)" },
    LOCKED_VAULT: { ring: "stroke-violet-400/70", fill: "fill-violet-500/10", text: "fill-violet-300", pulse: false, dim: false, label: "sealed vault" },
    ERROR: { ring: "stroke-alert", fill: "fill-alert/15", text: "fill-alert", pulse: false, dim: false, label: "error" },
  };
  const look = { ...base[n.state] };
  if (!n.configured && n.state === "DORMANT") look.label = "idle / unconfigured";
  if (away && n.id === "tony" && n.state !== "ACTIVE_TOKEN") look.dim = true;
  return look;
}

/** The edge a hand-off travels, oriented `from → to` (null: no drawn edge; the node flashes). */
export function pulseEdge(h: Pick<Handoff, "from" | "to" | "kind">): { from: string; to: string } | null {
  const strip = (s: string) => (s.startsWith("mem:") ? null : s);
  const from = strip(h.from);
  const to = strip(h.to);
  if (!from || !to || from === to || from === "idle" || to === "idle") return null;
  if (!LAYOUT[from] || !LAYOUT[to]) return null;
  return { from, to };
}

/** The node a memory read / write (or a script run, or a token taken from idle) lights up. */
export function flashNode(h: Pick<Handoff, "from" | "to" | "kind">): string | null {
  if (h.kind === "memory_read") return h.to;
  if (h.kind === "memory_write" || h.kind === "script") return h.from;
  if (h.kind === "token") return h.to === "idle" ? h.from : h.to;
  return null;
}

export const fmtMs = (ms: number | null | undefined) => (ms == null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

export const fmtGb = (mb: number | null | undefined) => (mb == null ? "—" : `${(mb / 1024).toFixed(1)}`);
