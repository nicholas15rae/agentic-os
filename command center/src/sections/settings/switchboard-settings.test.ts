import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@/lib/platform";
import { PRESET_MODES, type TonyMode } from "@/features/modes/modes";
import { DEFAULT_OS_SWITCHBOARD, osSwitchboard, ownsServer, toggleFrozen, toggleOwner } from "@/features/os/switchboard";
import { SwitchboardView, type SwitchboardViewProps } from "./SwitchboardSettings";
import { PHONE_READ_ONLY } from "./use-providers";

const server = (id: string, name: string, agents: string[] | null, enabled = true) => ({ id, name, agents, enabled, transport: "builtin", builtin: true }) as unknown as McpServer;
const MCPS = [server("time", "Time", ["general"]), server("gmail", "Gmail", ["general"]), server("git", "Git", ["coder"]), server("shotcut", "Shotcut", ["director"], false), server("weather", "Weather", null)];
const cfg: SwitchboardViewProps["cfg"] = { osName: "Tony", routing: { autoSwitch: true, agents: {} }, mcps: MCPS, switchboard: { version: 1, frozenAgents: ["booking"], frozenTools: ["shotcut"] } };
const preset = (id: string) => PRESET_MODES.find((m) => m.id === id)!;
const focus: TonyMode = { ...preset("surface"), id: "focus", name: "Focus", icon: "flame", agent_dispatch_policy: "ask_before_dispatch", switchboard: { agents: ["coder", "designer"], tools: ["git"] } };
const loose: TonyMode = { ...preset("surface"), id: "loose", name: "Loose", icon: "sparkles" };
const MODES = [...PRESET_MODES, focus, loose];

const props = (over: Partial<SwitchboardViewProps> = {}): SwitchboardViewProps => ({ cfg, modes: MODES, activeId: "builder", readOnly: false, onFreeze: vi.fn(), onMode: vi.fn(), onMcps: vi.fn(), ...over });
const html = (over: Partial<SwitchboardViewProps> = {}) => renderToStaticMarkup(createElement(SwitchboardView, props(over)));
/** One mode's / server's block of the markup. */
const block = (h: string, attr: string, id: string) => {
  const start = h.indexOf(`${attr}="${id}"`);
  const end = h.indexOf("</li>", start);
  return h.slice(start, end);
};

/** Every element in the (unrendered) tree SwitchboardView returns, so a test can press a pill. */
function elements(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (isValidElement(node)) {
    out.push(node);
    elements((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}
const byTitle = (p: SwitchboardViewProps, title: string) => {
  const el = elements(SwitchboardView(p)).find((e) => (e.props as { title?: string }).title === title);
  if (!el) throw new Error(`no element titled ${title}`);
  return el.props as { onClick?: () => void; disabled?: boolean };
};

describe("Switchboard → master switchboard (global freezes)", () => {
  it("shows Tony and the always-live tools locked, frozen agents and servers struck through", () => {
    const h = html();
    expect(h).toContain('title="Tony is always live"');
    expect(h).toContain('title="Time is always live"');
    expect(h).toMatch(/aria-pressed="false"[^>]*title="Booking Desk is frozen in every mode: click to thaw"[^>]*line-through/);
    expect(h).toMatch(/aria-pressed="true"[^>]*title="Freeze Coder in every mode"/);
    expect(h).toMatch(/title="Shotcut is frozen in every mode: click to thaw"/);
    expect(h).toContain("time, skills.read, tony.set_mode");
  });

  it("a toggle writes the whole switchboard with one id flipped (version kept)", () => {
    const onFreeze = vi.fn();
    const p = props({ onFreeze });
    byTitle(p, "Freeze Coder in every mode").onClick!();
    expect(onFreeze).toHaveBeenLastCalledWith({ version: 1, frozenAgents: ["booking", "coder"], frozenTools: ["shotcut"] });
    byTitle(p, "Booking Desk is frozen in every mode: click to thaw").onClick!();
    expect(onFreeze).toHaveBeenLastCalledWith({ version: 1, frozenAgents: [], frozenTools: ["shotcut"] });
    byTitle(p, "Freeze Gmail in every mode").onClick!();
    expect(onFreeze).toHaveBeenLastCalledWith({ version: 1, frozenAgents: ["booking"], frozenTools: ["shotcut", "gmail"] });
  });
});

describe("Switchboard → mode presets", () => {
  it("a built-in shows its on-duty agents and tools read-only, with no switchboard toggle", () => {
    const h = html();
    const builder = block(h, "data-mode", "builder");
    for (const l of ["Prompter", "Designer", "Coder"]) expect(builder).toContain(`>${l}</span>`);
    expect(builder).not.toContain(">Biz Ops<");
    // The preset's own overlay is read-only; only Tony's per-mode extras (os.json) are toggles.
    const [overlay, tonyExtras] = builder.split("adds in this mode");
    expect(overlay).not.toContain("<button");
    expect(tonyExtras).toContain('title="Take Git from Tony in Builder"');
    expect(builder).toContain("3 agents · 8 tools on duty");
    expect(builder).toContain(">Active<");
    const operations = block(h, "data-mode", "operations");
    expect(operations).not.toContain(">Ops</span>");
    expect(operations).toContain(">Biz Ops</span>");
    expect(block(h, "data-mode", "learning")).toContain("Night training");
    expect(block(h, "data-mode", "learning")).toContain("Tony only");
    expect(block(h, "data-mode", "brainstorm")).toContain("No switchboard: every agent and tool stays live");
    expect(h).not.toContain('data-mode="gabagool"');
  });

  it("a custom mode is editable: the overlay toggle, and pressable on-duty pills", () => {
    const h = html();
    const f = block(h, "data-mode", "focus");
    expect(f).toContain("Use a switchboard in this mode");
    expect(f).toMatch(/role="switch" aria-checked="true"/);
    expect(f).toMatch(/aria-pressed="true"[^>]*title="Freeze Coder in Focus"/);
    expect(f).toMatch(/aria-pressed="false"[^>]*title="Put on duty: Prompter in Focus"/);
    // The master freeze still shows on a custom mode's pill.
    expect(f).toMatch(/title="Put on duty: Booking Desk in Focus"[^>]*line-through/);
    const l = block(h, "data-mode", "loose");
    expect(l).toMatch(/role="switch" aria-checked="false"/);
  });

  it("editing a custom mode hands the whole edited mode to onMode", () => {
    const onMode = vi.fn();
    const p = props({ onMode });
    byTitle(p, "Freeze Coder in Focus").onClick!();
    expect(onMode).toHaveBeenLastCalledWith({ ...focus, switchboard: { agents: ["designer"], tools: ["git"] } });
    byTitle(p, "Put on duty: Gmail in Focus").onClick!();
    expect(onMode).toHaveBeenLastCalledWith({ ...focus, switchboard: { agents: ["coder", "designer"], tools: ["git", "gmail"] } });
    // Turning the overlay on starts from everything (nothing changes until an item is unticked).
    const toggle = elements(SwitchboardView(p)).filter((e) => (e.props as { label?: string }).label === "Use a switchboard in this mode");
    expect(toggle).toHaveLength(2);
    (toggle[1].props as { onChange: (v: boolean) => void }).onChange(true);
    expect(onMode).toHaveBeenLastCalledWith({ ...loose, switchboard: { agents: ["booking", "coder", "prompter", "designer", "director", "librarian", "bizops", "finance"], tools: ["gmail", "git", "shotcut", "weather"] } });
    (toggle[0].props as { onChange: (v: boolean) => void }).onChange(false);
    expect(onMode).toHaveBeenLastCalledWith({ ...focus, switchboard: null });
  });
});

describe("Switchboard → tool ownership", () => {
  it("shows each server's owners, Tony included", () => {
    const h = html();
    const gmail = block(h, "data-server", "gmail");
    expect(gmail).toMatch(/aria-pressed="true"[^>]*title="Tony is the last owner"/);
    expect(gmail).toMatch(/aria-pressed="false"[^>]*title="Give Gmail to Coder"/);
    const weather = block(h, "data-server", "weather");
    expect((weather.match(/aria-pressed="true"/g) ?? []).length).toBe(9); // Tony + 8 sub-agents
    expect(block(h, "data-server", "shotcut")).toContain(">off<");
    expect(block(h, "data-server", "shotcut")).toContain("frozen");
  });

  it("a grant edit writes the server list with that one grant flipped; the last owner stays", () => {
    const onMcps = vi.fn();
    const p = props({ onMcps });
    byTitle(p, "Give Gmail to Coder").onClick!();
    expect(onMcps.mock.calls[0][0].find((s: McpServer) => s.id === "gmail").agents).toEqual(["general", "coder"]);
    byTitle(p, "Take Weather from Tony").onClick!();
    expect(onMcps.mock.calls[1][0].find((s: McpServer) => s.id === "weather").agents).toEqual(["booking", "coder", "prompter", "designer", "director", "librarian", "bizops", "finance"]);
    expect(byTitle(p, "Tony is the last owner")).toMatchObject({ disabled: true, onClick: undefined });
  });
});

describe("Switchboard on the phone (read-only)", () => {
  it("says so, and nothing can be pressed", () => {
    const p = props({ readOnly: true });
    const h = html({ readOnly: true });
    expect(h).toContain(PHONE_READ_ONLY.replace(/'/g, "&#x27;"));
    expect(h).not.toContain("Use a switchboard in this mode");
    for (const b of h.match(/<button[^>]*>/g) ?? []) expect(b).toContain('disabled=""');
    expect(elements(SwitchboardView(p)).some((e) => typeof (e.props as { onClick?: unknown }).onClick === "function")).toBe(false);
  });
});

describe("Settings registration", () => {
  it("the Modes & Switchboard tab renders the card on desktop and phone", () => {
    const src = readFileSync(fileURLToPath(new URL("../SettingsSection.tsx", import.meta.url)), "utf8");
    expect(src).toContain('{ id: "modes", label: "Modes & Switchboard" }');
    const modesTab = src.slice(src.indexOf('{tab === "modes" && ('), src.indexOf('{tab === "integrations"'));
    expect(modesTab).toContain("<SwitchboardCard />");
    // Outside the desktop-only branch: the phone gets the read-only view.
    expect(modesTab.indexOf("<SwitchboardCard />")).toBeLessThan(modesTab.indexOf("desktop ?"));
  });
});

describe("switchboard helpers", () => {
  it("osSwitchboard: an older desktop without it freezes nothing; fields are normalised", () => {
    expect(osSwitchboard(null)).toEqual({ version: 0, frozenAgents: [], frozenTools: [] });
    expect(osSwitchboard({ switchboard: { frozenAgents: ["booking"] } })).toEqual({ version: 0, frozenAgents: ["booking"], frozenTools: [] });
    expect(DEFAULT_OS_SWITCHBOARD).toEqual({ version: 1, frozenAgents: ["booking", "librarian"], frozenTools: [] });
  });

  it("DEFAULT_OS_SWITCHBOARD freezes exactly what Rust seeds (os_core.rs DEFAULT_FROZEN_AGENTS)", () => {
    const rs = readFileSync(fileURLToPath(new URL("../../../src-tauri/src/commands/os_core.rs", import.meta.url)), "utf8");
    const m = rs.match(/pub const DEFAULT_FROZEN_AGENTS: \[&str; (\d+)\] = \[([^\]]*)\];/);
    expect(m, "os_core.rs DEFAULT_FROZEN_AGENTS").not.toBeNull();
    const rust = [...m![2].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    expect(rust).toHaveLength(Number(m![1]));
    expect(DEFAULT_OS_SWITCHBOARD.frozenAgents).toEqual(rust);
  });

  it("toggleFrozen flips one id", () => {
    expect(toggleFrozen(["booking"], "coder")).toEqual(["booking", "coder"]);
    expect(toggleFrozen(["booking", "coder"], "booking")).toEqual(["coder"]);
  });

  it("ownsServer mirrors McpServer::grants (missing / empty / all = everyone; tony = general)", () => {
    expect(ownsServer(null, "general")).toBe(true);
    expect(ownsServer([], "coder")).toBe(true);
    expect(ownsServer(["all"], "tony")).toBe(true);
    expect(ownsServer(["tony"], "general")).toBe(true);
    expect(ownsServer(["director"], "general")).toBe(false);
  });

  it("toggleOwner spells out 'all', keeps unknown ids, and never empties a list", () => {
    const all = ["general", "coder", "director"];
    expect(toggleOwner(null, "general", all)).toEqual(["coder", "director"]);
    expect(toggleOwner(["all"], "coder", all)).toEqual(["general", "director"]);
    expect(toggleOwner(["director"], "tony", all)).toEqual(["general", "director"]);
    expect(toggleOwner(["director", "trader"], "coder", all)).toEqual(["coder", "director", "trader"]);
    expect(toggleOwner(["director"], "director", all)).toEqual(["director"]);
  });
});
