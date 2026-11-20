import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EFFECTIVE, PRESET_MODES, effectiveOf, type ModesView } from "./modes";

const h = vi.hoisted(() => ({
  cmd: vi.fn(),
  onNativeEvent: vi.fn(),
  toggleGabagool: vi.fn(),
  gateway: vi.fn(),
  tauri: true,
  handler: null as null | ((v: unknown) => void),
}));

vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => h.tauri, onNativeEvent: h.onNativeEvent }));
vi.mock("@/features/cues/cue-runtime", () => ({ toggleGabagoolMode: h.toggleGabagool }));
vi.mock("@/lib/gateway", () => ({ gateway: h.gateway }));

import { useOs } from "@/features/os/os-store";
import type { OsConfig } from "@/lib/platform";
import { PHONE_MODE_REFRESH_MS, resetModesForTests, useModes } from "./modes-store";

const view = (active: string, overrides: Record<string, string> = {}): ModesView => ({
  modes: [...PRESET_MODES],
  active_mode_id: active,
  effective: effectiveOf(PRESET_MODES, active, overrides),
  overrides,
  builtin_ids: PRESET_MODES.map((m) => m.id),
});
const calls = (name: string) => h.cmd.mock.calls.filter((c) => c[0] === name);

beforeEach(() => {
  resetModesForTests();
  for (const f of [h.cmd, h.onNativeEvent, h.toggleGabagool, h.gateway]) f.mockReset();
  h.tauri = true;
  h.onNativeEvent.mockImplementation(async (_e: string, fn: (v: unknown) => void) => {
    h.handler = fn;
    return () => undefined;
  });
  h.cmd.mockImplementation(async (name: string, args?: { id?: string; patch?: Record<string, string> }) => {
    if (name === "tony_modes_get") return view("brainstorm");
    if (name === "tony_mode_set_active") return view(args!.id!);
    if (name === "tony_mode_override") return view("executive", args!.patch);
    if (name === "tony_mode_reset") return view("executive");
    throw new Error(`unexpected ${name}`);
  });
});

describe("mode changes reach the narrator's level (useOs.cfg, fix pass)", () => {
  it("a switch, a reset and a tony-mode-changed event all update cfg.feedback.sensitivity", async () => {
    useOs.setState({ cfg: { feedback: { sensitivity: 2 } } as unknown as OsConfig });
    await useModes.getState().load(); // brainstorm: milestones_only = 1
    expect(useOs.getState().cfg!.feedback.sensitivity).toBe(1);
    await useModes.getState().setActive("surface"); // silent = 0
    expect(useOs.getState().cfg!.feedback.sensitivity).toBe(0);
    useOs.setState({ cfg: { feedback: { sensitivity: 3 } } as unknown as OsConfig }); // a manual Verbose
    await useModes.getState().reset(); // executive's own level
    expect(useOs.getState().cfg!.feedback.sensitivity).toBe(view("executive").effective.feedback_level);
    h.handler!(view("builder")); // e.g. the phone switched modes
    expect(useOs.getState().cfg!.feedback.sensitivity).toBe(2);
    useOs.setState({ cfg: null });
  });
});

describe("modes store (desktop)", () => {
  it("starts as Brainstorming (today's offer card) until Rust answers", () => {
    expect(useModes.getState().effective).toEqual(DEFAULT_EFFECTIVE);
    expect(useModes.getState().effective.dispatch).toBe("ask_before_dispatch");
    expect(useModes.getState().loaded).toBe(false);
  });

  it("load reads tony_modes_get and listens for tony-mode-changed", async () => {
    await useModes.getState().load();
    expect(calls("tony_modes_get")).toHaveLength(1);
    expect(h.onNativeEvent).toHaveBeenCalledWith("tony-mode-changed", expect.any(Function));
    expect(useModes.getState().loaded).toBe(true);
    h.handler!(view("builder"));
    expect(useModes.getState().effective.mode_id).toBe("builder");
    expect(useModes.getState().effective.dispatch).toBe("auto_dispatch");
  });

  it("selecting Gabagool toggles the cue and never switches the work mode (D19)", async () => {
    await useModes.getState().setActive("gabagool");
    expect(h.toggleGabagool).toHaveBeenCalledTimes(1);
    expect(calls("tony_mode_set_active")).toHaveLength(0);
    expect(useModes.getState().activeId).toBe("brainstorm");
    await useModes.getState().toggleNovelty("gabagool");
    expect(h.toggleGabagool).toHaveBeenCalledTimes(2);
    expect(calls("tony_mode_set_active")).toHaveLength(0);
  });

  it("a work mode switches through tony_mode_set_active", async () => {
    await useModes.getState().setActive("executive");
    expect(calls("tony_mode_set_active")).toEqual([["tony_mode_set_active", { id: "executive" }]]);
    expect(useModes.getState().effective.curiosity).toBe("low");
  });

  it("override then reset call the right commands; the overridden flag clears on the event", async () => {
    await useModes.getState().load();
    await useModes.getState().override({ curiosity: "high" });
    expect(calls("tony_mode_override")).toEqual([["tony_mode_override", { patch: { curiosity: "high" } }]]);
    expect(useModes.getState().effective.overridden).toEqual(["curiosity"]);
    expect(useModes.getState().overrides).toEqual({ curiosity: "high" });
    await useModes.getState().reset();
    expect(calls("tony_mode_reset")).toHaveLength(1);
    // Rust's event is the source of truth (e.g. a reset from the phone).
    h.handler!(view("executive", { curiosity: "high" }));
    expect(useModes.getState().effective.overridden).toEqual(["curiosity"]);
    h.handler!(view("executive"));
    expect(useModes.getState().effective.overridden).toEqual([]);
    expect(useModes.getState().overrides).toEqual({});
  });

  it("a refused command keeps the state and surfaces the error", async () => {
    h.cmd.mockRejectedValueOnce(new Error("mode \"x\" not found"));
    await expect(useModes.getState().setActive("x")).rejects.toThrow(/not found/);
    expect(useModes.getState().error).toMatch(/not found/);
    expect(useModes.getState().activeId).toBe("brainstorm");
  });
});

describe("modes store (phone)", () => {
  it("reads the mirror and writes through the inbox command", async () => {
    h.tauri = false;
    h.gateway.mockImplementation(async (path: string) => {
      if (path === "/api/os/state")
        return { mode: { id: "builder", name: "Builder", icon: "hammer", curiosity: "medium", verbosity: "balanced", dispatch: "auto_dispatch", feedbackLevel: 2, overridden: [], list: PRESET_MODES.map((m) => ({ id: m.id, name: m.name, icon: m.icon, isNovelty: m.is_novelty })) } };
      return { id: "q1" };
    });
    await useModes.getState().load();
    expect(useModes.getState().effective.dispatch).toBe("auto_dispatch");
    vi.useFakeTimers();
    try {
      await useModes.getState().setActive("surface");
      await useModes.getState().override({ dispatch: "surface_only" });
      await useModes.getState().reset();
    } finally {
      vi.useRealTimers();
    }
    const posted = h.gateway.mock.calls.filter((c) => c[0] === "/api/os/inbox").map((c) => JSON.parse(c[1].body));
    expect(posted).toEqual([
      { kind: "command", payload: { modeId: "surface" } },
      { kind: "command", payload: { overrides: { dispatch: "surface_only" } } },
      { kind: "command", payload: { resetOverrides: true } },
    ]);
    expect(h.cmd).not.toHaveBeenCalled();
    // Editing is desktop-only.
    await expect(useModes.getState().remove("my-mode")).rejects.toThrow(/desktop-only/);
  });

  it("re-reads the mirror while visible, so a desktop switch reaches the phone (fix pass)", async () => {
    h.tauri = false;
    const listeners: Record<string, () => void> = {};
    const doc = { visibilityState: "visible", addEventListener: (e: string, fn: () => void) => (listeners[`doc:${e}`] = fn) };
    vi.stubGlobal("window", { addEventListener: (e: string, fn: () => void) => (listeners[`win:${e}`] = fn) });
    vi.stubGlobal("document", doc);
    let mirrorId = "builder";
    h.gateway.mockImplementation(async (path: string) => {
      if (path === "/api/os/state") return { mode: { id: mirrorId, name: mirrorId, icon: "x", curiosity: "medium", verbosity: "balanced", dispatch: mirrorId === "surface" ? "surface_only" : "auto_dispatch", feedbackLevel: 1, overridden: [], list: [] } };
      return {};
    });
    vi.useFakeTimers();
    try {
      await useModes.getState().load();
      expect(useModes.getState().effective.dispatch).toBe("auto_dispatch");
      mirrorId = "surface"; // the desktop switched to Solo
      await vi.advanceTimersByTimeAsync(PHONE_MODE_REFRESH_MS + 10);
      expect(useModes.getState().effective.dispatch).toBe("surface_only");
      mirrorId = "builder";
      listeners["win:focus"]();
      await vi.advanceTimersByTimeAsync(0);
      expect(useModes.getState().effective.dispatch).toBe("auto_dispatch");
    } finally {
      resetModesForTests();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
