import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EDGES, LAYOUT, flashNode, nodeLook, pulseEdge } from "./agent-graph";
import { AwayButtonView } from "./AwayButton";

const rs = readFileSync(resolve(__dirname, "../../../src-tauri/src/commands/arbiter.rs"), "utf8");

describe("agent topology", () => {
  it("lays out every Rust roster node and mirrors arbiter::EDGES", () => {
    const ids = [...rs.matchAll(/node\("([a-z_]+)", "/g)].map((m) => m[1]);
    expect(ids.length).toBe(Object.keys(LAYOUT).length);
    for (const id of ids) expect(LAYOUT[id], id).toBeDefined();
    for (const [a, b] of EDGES) expect(rs).toContain(`("${a}", "${b}")`);
    expect(rs).toContain(`pub const EDGES: [(&str, &str); ${EDGES.length}]`);
  });

  it("states read distinctly; Away Mode dims Tony", () => {
    const n = (state: Parameters<typeof nodeLook>[0]["state"], id = "coder") => nodeLook({ id, state, configured: true }, false);
    expect(n("ACTIVE_TOKEN").pulse).toBe(true);
    expect(n("DORMANT").dim).toBe(true);
    expect(n("LOCKED_VAULT", "finance").label).toBe("sealed vault");
    expect(nodeLook({ id: "booking", state: "DORMANT", configured: false }, false).label).toBe("idle / unconfigured");
    expect(nodeLook({ id: "tony", state: "QUEUED", configured: true }, true).dim).toBe(true);
    expect(nodeLook({ id: "tony", state: "ACTIVE_TOKEN", configured: true }, true).dim).toBe(false);
  });

  it("pulses the exact edge, flashes memory and script nodes", () => {
    expect(pulseEdge({ from: "prompter", to: "coder", kind: "token" })).toEqual({ from: "prompter", to: "coder" });
    expect(pulseEdge({ from: "idle", to: "coder", kind: "token" })).toBeNull();
    expect(pulseEdge({ from: "mem:build_circle", to: "coder", kind: "memory_read" })).toBeNull();
    expect(flashNode({ from: "mem:build_circle", to: "coder", kind: "memory_read" })).toBe("coder");
    expect(flashNode({ from: "garbage", to: "garbage", kind: "script" })).toBe("garbage");
    expect(flashNode({ from: "coder", to: "idle", kind: "token" })).toBe("coder");
  });

  it("the Away switch says its state", () => {
    const on = renderToStaticMarkup(createElement(AwayButtonView, { away: true, onToggle: () => undefined }));
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(renderToStaticMarkup(createElement(AwayButtonView, { away: false, onToggle: () => undefined }))).toContain('aria-checked="false"');
  });
});
