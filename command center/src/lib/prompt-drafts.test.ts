// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from "vitest";
import { countLabel, estimateTokens, HISTORY_MAX, isPromptFile, loadHistory, pushHistory, withHistory } from "./prompt-drafts";
import { isEditingShortcut } from "./editing-keys";

// nav.ts and the My Apps store touch window / location / localStorage at import: minimal stand-ins.
beforeAll(() => {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { localStorage: storage, addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal("location", { hash: "", search: "" });
  vi.stubGlobal("history", { replaceState: () => undefined });
});

describe("prompt history", () => {
  it("keeps the newest first, without duplicates, capped", () => {
    let h: string[] = [];
    for (let i = 0; i < HISTORY_MAX + 5; i++) h = withHistory(h, `p${i}`);
    expect(h).toHaveLength(HISTORY_MAX);
    expect(h[0]).toBe(`p${HISTORY_MAX + 4}`);
    expect(withHistory(["a", "b", "c"], " b ")).toEqual(["b", "a", "c"]);
    expect(withHistory(["a"], "   ")).toEqual(["a"]);
  });

  it("stores a long master prompt whole", () => {
    const big = Array.from({ length: 200 }, (_, i) => `## Section ${i}\nDo the thing for section ${i}.`).join("\n\n");
    expect(big.length).toBeGreaterThan(5000);
    pushHistory("test", big);
    expect(loadHistory("test")[0]).toBe(big);
  });
});

describe("counter and drop filter", () => {
  it("estimates tokens at ~4 chars each", () => {
    expect(estimateTokens("x".repeat(400))).toBe(100);
    expect(countLabel("x".repeat(12_345))).toBe("12,345 chars · ~3.1k tokens");
  });
  it("accepts .md and .txt only", () => {
    expect(isPromptFile({ name: "Master Prompt.MD" })).toBe(true);
    expect(isPromptFile({ name: "notes.txt" })).toBe(true);
    expect(isPromptFile({ name: "photo.png", type: "image/png" })).toBe(false);
  });
});

describe("editing shortcuts belong to the focused field", () => {
  const ta = { tagName: "TEXTAREA" } as unknown as EventTarget;
  const text = { tagName: "INPUT", type: "text" } as unknown as EventTarget;
  const div = { tagName: "DIV" } as unknown as EventTarget;
  const checkbox = { tagName: "INPUT", type: "checkbox" } as unknown as EventTarget;
  const key = (k: string, target: EventTarget, mods: Partial<KeyboardEvent> = { ctrlKey: true }) => isEditingShortcut({ key: k, ctrlKey: false, metaKey: false, altKey: false, target, ...mods });
  it("claims Ctrl+A/C/V/X/Z/Y in a text field", () => {
    for (const k of ["a", "c", "v", "x", "z", "y", "Z"]) expect(key(k, ta)).toBe(true);
    expect(key("a", text)).toBe(true);
    expect(key("a", ta, { metaKey: true })).toBe(true);
  });
  it("leaves app shortcuts and non-text targets alone", () => {
    expect(key("k", ta)).toBe(false);
    expect(key("a", div)).toBe(false);
    expect(key("a", checkbox)).toBe(false);
    expect(key("a", ta, { ctrlKey: false })).toBe(false);
    expect(key("ArrowLeft", ta, { ctrlKey: true, altKey: true })).toBe(false); // Ctrl+Alt+← pages
  });
  it("never claims Ctrl+Shift+X (the trading E-stop); cut and redo stay the field's", () => {
    expect(key("X", ta, { ctrlKey: true, shiftKey: true })).toBe(false);
    expect(key("x", text, { metaKey: true, shiftKey: true })).toBe(false);
    expect(key("x", ta)).toBe(true); // Ctrl+X
    expect(key("Z", ta, { ctrlKey: true, shiftKey: true })).toBe(true); // Ctrl+Shift+Z
  });
});

describe("mounted app routes", () => {
  it("parses #/app/<id> and fixed sections", async () => {
    const { parseHash } = await import("@/stores/nav");
    expect(parseHash("#/app/build-b-123")).toEqual({ section: "app", appId: "build-b-123" });
    expect(parseHash("#/playplace")).toEqual({ section: "playplace", appId: null });
    expect(parseHash("#/app")).toEqual({ section: "command", appId: null });
    expect(parseHash("#/nope")).toEqual({ section: "command", appId: null });
  });
  it("mounts, relabels, reorders and unpins without touching anything else", async () => {
    const { moved, useMyApps } = await import("@/features/myapps/store");
    const l = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(moved(l, "b", -1).map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(moved(l, "c", 1)).toBe(l);
    const s = useMyApps.getState();
    const a = s.mount({ kind: "build", ref: "b-1", title: "Audition Tracker" });
    s.mount({ kind: "card", ref: "c-2", title: "Tip Calc" }, { label: "  Tips  ", icon: "calculator" });
    expect(useMyApps.getState().apps.map((x) => [x.id, x.label, x.icon])).toEqual([
      ["build-b-1", "Audition Tracker", "app"],
      ["card-c-2", "Tips", "calculator"],
    ]);
    s.move("card-c-2", -1);
    expect(useMyApps.getState().apps[0].id).toBe("card-c-2");
    s.mount({ kind: "build", ref: "b-1", title: "Renamed upstream" }); // re-pin keeps label and order
    expect(useMyApps.getState().apps.map((x) => x.label)).toEqual(["Tips", "Audition Tracker"]);
    s.unmount(a.id);
    expect(useMyApps.getState().apps.map((x) => x.id)).toEqual(["card-c-2"]);
    s.addPending({ slug: "focus-timer", label: "Focus", icon: "timer" });
    s.resolvePending([{ id: "b-9", slug: "focus-timer" }]);
    expect(useMyApps.getState().apps.find((x) => x.ref === "b-9")?.label).toBe("Focus");
    expect(useMyApps.getState().pending).toEqual([]);
  });
});
