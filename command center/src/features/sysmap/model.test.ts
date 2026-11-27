import { describe, expect, it } from "vitest";
import { EDGES } from "@/features/arbiter/agent-graph";
import type { SnapBus, SnapSkill } from "@/lib/platform";
import {
  BOUNDARY,
  BUS_LANE,
  busPath,
  CARD_H,
  CARD_W,
  clampView,
  FLOW_H,
  FLOW_NODES,
  FLOW_W,
  hookupsFor,
  isIsolated,
  liveTraces,
  moonSize,
  NODE_BUS,
  orbitPos,
  ORBITS,
  ROSTER,
  siblingLinks,
  skillsFor,
  surfaceState,
  tracesFor,
} from "./model";

describe("surfaceState", () => {
  it("maps every arbiter state to the surface word", () => {
    expect(surfaceState(undefined)).toBe("OFFLINE");
    expect(surfaceState({ state: "ACTIVE_TOKEN", configured: true })).toBe("ACTIVE");
    expect(surfaceState({ state: "ACTIVE", configured: true })).toBe("ACTIVE");
    expect(surfaceState({ state: "QUEUED", configured: true })).toBe("QUEUED");
    expect(surfaceState({ state: "LOCKED_VAULT", configured: true })).toBe("SEALED");
    expect(surfaceState({ state: "ERROR", configured: true })).toBe("ERROR");
    expect(surfaceState({ state: "DORMANT", configured: true })).toBe("IDLE");
    expect(surfaceState({ state: "DORMANT", configured: false })).toBe("DORMANT");
  });
});

describe("tracesFor / liveTraces", () => {
  it("lights the target's bus for Tony's hand-offs, both ways", () => {
    expect(tracesFor({ from: "tony", to: "librarian", kind: "handoff" })).toEqual(["bus:librarian"]);
    expect(tracesFor({ from: "booking", to: "tony", kind: "handoff" })).toEqual(["bus:booking"]);
  });
  it("lights a side link between siblings in one column, else both buses", () => {
    expect(tracesFor({ from: "prompter", to: "coder", kind: "token" })).toEqual(["link:coder~prompter"]);
    expect(tracesFor({ from: "coder", to: "librarian", kind: "handoff" })).toEqual(["bus:coder", "bus:librarian"]);
    expect(tracesFor({ from: "observer", to: "security", kind: "handoff" })).toEqual(["bus:observer", "bus:security"]);
  });
  it("lights the RAG drop on memory I/O and nothing for idle / unknown nodes", () => {
    expect(tracesFor({ from: "mem:librarian", to: "librarian", kind: "memory_read" })).toEqual(["rag:librarian"]);
    expect(tracesFor({ from: "coder", to: "mem:build_circle", kind: "memory_write" })).toEqual(["rag:coder"]);
    expect(tracesFor({ from: "idle", to: "coder", kind: "token" })).toEqual([]);
    expect(tracesFor({ from: "tony", to: "martian", kind: "handoff" })).toEqual([]);
  });
  it("only keeps hand-offs inside the window (nothing lit while idle)", () => {
    const p = [
      { from: "tony", to: "coder", kind: "handoff" as const, at: 1000 },
      { from: "tony", to: "ops", kind: "handoff" as const, at: 9000 },
    ];
    expect([...liveTraces(p, 10_000, 1600).keys()]).toEqual(["bus:ops"]);
    expect(liveTraces(p, 50_000, 1600).size).toBe(0);
  });
});

describe("schematic layout", () => {
  it("places every specialist inside the canvas without overlapping cards", () => {
    const ids = Object.keys(FLOW_NODES) as (keyof typeof FLOW_NODES)[];
    for (const id of ids) {
      const n = FLOW_NODES[id];
      expect(n.x - CARD_W / 2).toBeGreaterThanOrEqual(0);
      expect(n.x + CARD_W / 2).toBeLessThanOrEqual(FLOW_W);
      expect(n.y + CARD_H / 2).toBeLessThanOrEqual(FLOW_H);
    }
    for (const a of ids)
      for (const b of ids) {
        if (a >= b) continue;
        const p = FLOW_NODES[a];
        const q = FLOW_NODES[b];
        const apart = Math.abs(p.x - q.x) >= CARD_W || Math.abs(p.y - q.y) >= CARD_H;
        expect(apart, `${a} / ${b}`).toBe(true);
      }
  });
  it("routes every bus with 90° segments only", () => {
    for (const id of Object.keys(FLOW_NODES) as (keyof typeof FLOW_NODES)[]) {
      expect(busPath(id)).toMatch(/^M [\d.-]+ [\d.-]+( [VH] [\d.-]+)+$/);
    }
    // Each bus has its own lane (or the centre): parallel traces never share an x.
    expect(new Set(Object.values(BUS_LANE)).size).toBeGreaterThanOrEqual(5);
  });
  it("draws side links only for valid same-column edges", () => {
    const links = siblingLinks(EDGES).map(([a, b]) => [a, b].sort().join("~"));
    expect(links).toContain("coder~prompter");
    expect(links).toContain("coder~designer");
    expect(links).not.toContain("garbage~security");
    expect(links.some((k) => k.includes("tony"))).toBe(false);
  });
  it("clamps zoom and pan", () => {
    expect(clampView({ x: 0, y: 0, k: 99 }).k).toBe(3);
    expect(clampView({ x: 0, y: 0, k: 0.01 }).k).toBe(0.3);
    expect(clampView({ x: 1e9, y: -1e9, k: 1 }).x).toBeLessThan(FLOW_W);
  });
});

describe("introspect joins", () => {
  const bus = (id: string, name: string) => ({ id, name, transport: "stdio", status: "ok", error: null, tools: 3 }) as SnapBus;
  it("matches MCP hookups by id or name", () => {
    const all = [bus("brave-search", "Brave Search"), bus("filesystem", "Filesystem"), bus("n8n", "n8n")];
    expect(hookupsFor("tony", all).map((b) => b.id)).toEqual(["brave-search"]);
    expect(hookupsFor("coder", all).map((b) => b.id)).toEqual(["filesystem"]);
    expect(hookupsFor("garbage", all)).toEqual([]);
  });
  it("finds skills granted to a node by role (Tony also as general)", () => {
    const sk = (name: string, agents: string[]) => ({ name, agents, folder: name, description: "", path: name, root: "" }) as SnapSkill;
    const items = [sk("tdd", ["coder"]), sk("brief", ["general"]), sk("x", ["Librarian"])];
    expect(skillsFor("coder", items).map((s) => s.name)).toEqual(["tdd"]);
    expect(skillsFor("tony", items).map((s) => s.name)).toEqual(["brief"]);
    expect(skillsFor("librarian", items).map((s) => s.name)).toEqual(["x"]);
  });
});

describe("orbits", () => {
  it("puts Tony at the centre and every other body on its own orbit radius", () => {
    expect(orbitPos(ORBITS.tony, 123)).toEqual([0, 0, 0]);
    for (const id of ROSTER) {
      if (id === "tony") continue;
      const [x, y, z] = orbitPos(ORBITS[id], 10);
      const r = Math.hypot(x, y, z);
      expect(r).toBeGreaterThan(ORBITS[id].radius * 0.8 - 0.01);
      expect(r).toBeLessThanOrEqual(ORBITS[id].radius + 0.01);
    }
    expect(NODE_BUS.finance).toBe("vault");
    expect(ORBITS.finance.kind).toBe("vault");
  });
  it("grows moons with the live counts on a log scale", () => {
    expect(moonSize(0, 1)).toBeCloseTo(0.55);
    expect(moonSize(9, 1)).toBeCloseTo(0.8);
    expect(moonSize(null, 1)).toBeCloseTo(0.55);
    expect(moonSize(1000, 1)).toBeGreaterThan(moonSize(10, 1));
  });
});

describe("Trading Agent on the map (isolated, Financer-only)", () => {
  it("is in the roster on its own bus, off Tony's spine", () => {
    expect(ROSTER).toContain("trading");
    expect(isIsolated("trading")).toBe(true);
    expect(isIsolated("finance")).toBe(false);
    expect(NODE_BUS.trading).toBe("trading");
    expect(BOUNDARY.trading).toMatch(/Financer/);
    expect(BOUNDARY.trading).toMatch(/Security Detail/);
    expect(BOUNDARY.trading).toMatch(/127\.0\.0\.1:7497/);
  });

  it("links only to the Financer, as a same-column side link", () => {
    const links = siblingLinks([["trading", "finance"], ["finance", "trading"], ["tony", "trading"]]);
    expect(links).toEqual([["trading", "finance"]]);
    expect(tracesFor({ from: "trading", to: "finance", kind: "handoff" })).toEqual(["link:finance~trading"]);
  });

  it("its card doesn't overlap the bottom row or leave the canvas", () => {
    const t = FLOW_NODES.trading;
    const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.abs(a.x - b.x) < CARD_W && Math.abs(a.y - b.y) < CARD_H;
    for (const id of ["observer", "security", "garbage", "bizops"] as const) expect(overlaps(t, FLOW_NODES[id]), id).toBe(false);
    expect(t.x + CARD_W / 2).toBeLessThanOrEqual(FLOW_W);
    expect(t.y + CARD_H / 2).toBeLessThanOrEqual(FLOW_H);
    expect(ORBITS.trading.radius).toBeGreaterThan(ORBITS.finance.radius);
  });
});
