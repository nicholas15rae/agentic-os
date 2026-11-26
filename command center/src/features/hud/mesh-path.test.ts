import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MESH_PATH_POLL_MS, meshPathChip, relayTag, type NetPath } from "./mesh-path";

const p2p: NetPath = {
  peer: "r0qcsx",
  ip: "100.84.84.190",
  status: "Connected",
  path: "P2P",
  iceLocal: "srflx",
  iceRemote: "prflx",
  relayHost: null,
  latencyMs: 30.6,
  lastHandshake: "2026-11-26T09:00:05-05:00",
  lazy: false,
};
const relayed: NetPath = { ...p2p, path: "Relayed", iceLocal: "relay", iceRemote: "relay", relayHost: "streamline-us-chi1-4.relay.netbird.io", latencyMs: 92.4, lazy: true };

describe("the phone HUD's NetBird path chip", () => {
  it("a direct link reads P2P with whole milliseconds, teal", () => {
    expect(meshPathChip(p2p)).toEqual({ text: "P2P 31 ms", tone: "direct", title: "NetBird: direct to the desktop (ICE srflx/prflx)" });
  });

  it("a relayed link names the relay's site code, amber", () => {
    const c = meshPathChip(relayed);
    expect(c).toMatchObject({ text: "RELAY chi1 92 ms", tone: "relay" });
    expect(c?.title).toContain("via streamline-us-chi1-4.relay.netbird.io");
    expect(c?.title).toContain("lazy connections on");
  });

  it("no latency or relay host yet still says which path", () => {
    expect(meshPathChip({ ...p2p, latencyMs: null })?.text).toBe("P2P");
    expect(meshPathChip({ ...relayed, relayHost: null, latencyMs: 0 })?.text).toBe("RELAY");
  });

  it("stays quiet for anything it can't read", () => {
    expect(meshPathChip(null)).toBeNull();
    expect(meshPathChip("nope")).toBeNull();
    expect(meshPathChip({ ...p2p, status: "Idle", path: null })).toBeNull();
    expect(meshPathChip({ ...p2p, status: "Connecting" })).toBeNull();
    expect(meshPathChip({ peer: null, status: "unknown", path: null })).toBeNull();
    expect(meshPathChip({ ...p2p, path: "Something" })).toBeNull();
    // The desktop's loopback answer is every peer, not "this phone": no chip.
    expect(meshPathChip({ lazy: true, peers: [p2p] })).toBeNull();
  });

  it("relay site codes", () => {
    expect(relayTag("streamline-us-chi1-4.relay.netbird.io")).toBe("chi1");
    expect(relayTag("streamline-eu-fra2-1.relay.netbird.io")).toBe("fra2");
    expect(relayTag("relay.example.net")).toBe("relay");
    expect(relayTag("averyveryverylongrelayname.example.net")).toBe("averyveryve…");
    expect(relayTag("")).toBeNull();
    expect(relayTag(null)).toBeNull();
  });

  it("polls every 30-60 s", () => {
    expect(MESH_PATH_POLL_MS).toBeGreaterThanOrEqual(30_000);
    expect(MESH_PATH_POLL_MS).toBeLessThanOrEqual(60_000);
  });

  // MobileHud.tsx is a browser-only component, so its wiring is checked from source.
  it("the MESH chip asks /api/net/path on the phone only and fails quietly", () => {
    // Normalise line endings: core.autocrlf=true checks MobileHud.tsx out as CRLF.
    const src = readFileSync(fileURLToPath(new URL("./MobileHud.tsx", import.meta.url)), "utf-8").replace(/\r\n/g, "\n");
    const hook = /function useMeshPath\(\)[\s\S]*?\n}\n/.exec(src)?.[0] ?? "";
    expect(hook).not.toBe("");
    expect(hook).toContain('if (isTauri()) return;');
    expect(hook).toContain('"/api/net/path"');
    expect(hook).toContain("setInterval(load, MESH_PATH_POLL_MS)");
    expect(hook).toContain(".catch(() => live && setChip(null))");
    expect(hook).toContain("clearInterval(iv)");
    expect(src).toMatch(/const meshPath = useMeshPath\(\);/);
    expect(src).toMatch(/meshPath\.tone === "direct" \? "text-teal" : "text-amber-light"/);
    // Phones show no tooltips: a tap on the chip reveals the ICE details line instead.
    expect(src).toMatch(/onClick=\{\(\) => setPathInfo\(\(v\) => !v\)\}/);
    expect(src).toMatch(/\{pathInfo && meshPath && <span[^>]*>\{meshPath\.title\}<\/span>\}/);
  });
});
