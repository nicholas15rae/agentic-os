import { describe, expect, it } from "vitest";
import type { McpServer, ServerTools } from "@/lib/platform";
import { agentServers, DEFAULT_TONY_MODE_TOOLS, INTENDED_SHARED, loadOf, sharedKey, sharedServers, TONY_SPOTIFY_CORE, TOOL_WARN, tonyModeTools, toggleTonyModeTool } from "./tool-load";

const srv = (id: string, agents: string[] | null, enabled = true) => ({ id, name: id, enabled, agents }) as unknown as McpServer;
const listing = (id: string, n: number) => ({ id, name: id, enabled: true, ok: true, error: null, status: "ok", auth: null, tools: Array.from({ length: n }, (_, i) => ({ name: `${id}.t${i}`, description: "x".repeat(40), server: id, args: ["a"] })) }) as ServerTools;

const mcps = [srv("time", ["general"]), srv("gmail", ["general"]), srv("git", ["coder"]), srv("filesystem", ["coder", "prompter"]), srv("maps", ["ops"]), srv("knowledge-graph", ["general", "prompter"])];
const base = { modeTools: null, frozenTools: [] as string[], frozen: false };

describe("tool load", () => {
  it("mirrors Rust's per-mode extras for Tony", () => {
    expect(DEFAULT_TONY_MODE_TOOLS.builder).toEqual(["git", "filesystem"]);
    expect(tonyModeTools({})).toEqual({ builder: ["git", "filesystem"], operations: ["maps", "instagram", "fetch"], executive: ["fetch"] });
    expect(toggleTonyModeTool({ builder: ["git"] }, "builder", "git")).toEqual({ builder: [] });
    expect(toggleTonyModeTool({}, "coach", "fetch")).toEqual({ coach: ["fetch"] });
  });

  it("Tony = base (every mode) + the mode's extras; a frozen agent gets nothing", () => {
    expect(agentServers({ mcps }, "general", { ...base, modeId: "learning", modeTools: [] })).toEqual(["time", "gmail", "knowledge-graph"]);
    expect(agentServers({ mcps }, "general", { ...base, modeId: "builder" })).toEqual(["time", "gmail", "git", "filesystem", "knowledge-graph"]);
    expect(agentServers({ mcps }, "general", { ...base, modeId: "builder", frozenTools: ["gmail"] })).toEqual(["time", "git", "filesystem", "knowledge-graph"]);
    expect(agentServers({ mcps }, "ops", { ...base, modeId: "x", frozen: true })).toEqual([]);
    expect(agentServers({ mcps }, "coder", { ...base, modeId: "builder", modeTools: ["git"] })).toEqual(["git"]);
  });

  it("counts tools, estimates tokens, warns over the limit", () => {
    const l = loadOf("general", ["gmail", "git", "nope"], [listing("gmail", 4), listing("git", TOOL_WARN)]);
    expect(l.tools).toBe(4 + TOOL_WARN);
    expect(l.warn).toBe(true);
    expect(l.unlisted).toEqual(["nope"]);
    expect(l.tokens).toBeGreaterThan(0);
    expect(loadOf("x", ["gmail"], [listing("gmail", 3)]).warn).toBe(false);
  });

  it("flags a server more than one active agent owns", () => {
    const s = sharedServers(mcps, ["general", "coder", "prompter"]);
    expect(s).toEqual([
      { server: "filesystem", owners: ["coder", "prompter"] },
      { server: "knowledge-graph", owners: ["general", "prompter"] },
    ]);
    // The clock is always shared and never flagged; a frozen agent doesn't count.
    expect(sharedServers(mcps, ["general", "coder"])).toEqual([]);
    expect(sharedKey({ server: "fs", owners: ["b", "a"] })).toBe("fs:a,b");
  });

  it("never flags the intended pairs (Maps: Tony + Ops; Instagram: Biz Ops + Tony read-only)", () => {
    expect(INTENDED_SHARED).toEqual({ maps: ["general", "ops"], instagram: ["general", "bizops"] });
    const m = [srv("maps", ["general", "ops"]), srv("instagram", ["bizops", "general"]), srv("gmail", ["general", "ops"])];
    expect(sharedServers(m, ["general", "ops", "bizops"])).toEqual([{ server: "gmail", owners: ["general", "ops"] }]);
    // A third owner on an intended server is flagged again.
    expect(sharedServers([srv("maps", ["general", "ops", "coder"])], ["general", "ops", "coder"])).toEqual([{ server: "maps", owners: ["general", "ops", "coder"] }]);
  });

  it("counts Tony's one read-only Finance tool; no other agent is ever handed it (Section 11.10)", () => {
    const finance = { ...listing("finance", 0), tools: [{ name: "finance.ask", description: "Answer a money question from Nic's Finance records (read-only, CA$).", server: "finance", args: ["question_kind", "area?", "agent?", "period?"] }] } as ServerTools;
    const m = [...mcps, srv("finance", ["general"])];
    const tony = agentServers({ mcps: m }, "general", { ...base, modeId: "learning", modeTools: [] });
    expect(tony).toContain("finance");
    expect(loadOf("general", tony, [finance]).tools).toBe(1);
    // Granted to "all" (or to the Coder) by mistake: Rust refuses it, so the load never counts it.
    const open = [srv("finance", null)];
    expect(agentServers({ mcps: open }, "coder", { ...base, modeId: "builder" })).toEqual([]);
    expect(agentServers({ mcps: open }, "finance", { ...base, modeId: "executive" })).toEqual(["finance"]);
  });

  it("counts Tony's one read-only vault search tool; no other agent is ever handed it (Section 16.6)", () => {
    const vault = { ...listing("vault", 0), tools: [{ name: "vault.search", description: "Search Nic's saved notes (never finance).", server: "vault", args: ["query", "kind?", "limit?"] }] } as ServerTools;
    const m = [...mcps, srv("vault", ["general"])];
    const tony = agentServers({ mcps: m }, "general", { ...base, modeId: "learning", modeTools: [] });
    expect(tony).toContain("vault");
    expect(loadOf("general", tony, [vault]).tools).toBe(1);
    // Granted to "all" by mistake: Rust refuses it for everyone but Tony, so the load never counts it.
    const open = [srv("vault", null)];
    for (const a of ["coder", "librarian", "finance", "prompter"]) expect(agentServers({ mcps: open }, a, { ...base, modeId: "builder" })).toEqual([]);
    expect(agentServers({ mcps: open }, "general", { ...base, modeId: "builder" })).toEqual(["vault"]);
  });

  it("Tony's Spotify load is the core five plus one spotify.more (Section 20.11)", () => {
    const names = ["now_playing", "get_queue", "recently_played", "top_items", "list_playlists", "get_playlist_tracks", "play", "pause", "resume", "next", "previous", "seek", "restart_track", "volume", "shuffle", "repeat", "transfer_device", "queue_add", "create_playlist", "add_to_playlist", "remove_from_playlist", "like_track", "unlike_track"];
    const spotify = { ...listing("spotify", 0), tools: names.map((n) => ({ name: `spotify.${n}`, description: "x".repeat(60), server: "spotify", args: [] })) } as ServerTools;
    expect(TONY_SPOTIFY_CORE).toHaveLength(5);
    const tony = loadOf("general", ["spotify"], [spotify]);
    expect(tony.tools).toBe(6);
    expect(tony.warn).toBe(false);
    // Anyone else's estimate counts the listing as it is.
    expect(loadOf("director", ["spotify"], [spotify]).tools).toBe(23);
    expect(tony.tokens).toBeLessThan(loadOf("director", ["spotify"], [spotify]).tokens);
  });
});
