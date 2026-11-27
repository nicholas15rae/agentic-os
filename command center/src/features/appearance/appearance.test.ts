import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_THEMES, DEFAULT_TOKENS, STYLE_KIT_DEFAULTS, contrast, resolveTokens, sanitizePatch, styleKitVars, tokensToCss } from "./theme";
import { diffFromDefault, resolvedFor, sanitizeAppearance, useAppearance } from "./appearance-store";
import { applyUiFile, buildUiFile, parseUiFile } from "./ui-file";
import { useLayout } from "@/core/widgets/layout-store";

const css = readFileSync(resolve(__dirname, "../../styles/index.css"), "utf8");

describe("design tokens", () => {
  it("the defaults are exactly the shipped look (index.css :root defaults agree)", () => {
    const vars = tokensToCss(DEFAULT_TOKENS);
    for (const k of ["--cc-card-bg", "--cc-glass-blur", "--cc-border-w", "--cc-edge", "--cc-shadow", "--cc-radius-scale", "--cc-font-scale", "--cc-icon-stroke", "--cc-accent-rgb", "--cc-accent2-rgb"])
      expect(css).toContain(`${k}: ${vars[k]};`);
    expect(css).toContain(`--color-amber: ${DEFAULT_TOKENS.accent};`);
    expect(vars["--spacing"]).toBe("0.25rem");
  });

  it("drops unknown keys, bad colours and out-of-range numbers", () => {
    expect(sanitizePatch({ accent: "red", ink: "#ABCDEF", radius: 99, fontScale: "big", evil: "x", motion: "wild", cardStyle: "solid" })).toEqual({ ink: "#abcdef", radius: 32, cardStyle: "solid" });
    expect(sanitizePatch(null)).toEqual({});
  });

  it("text never becomes unreadable: low contrast falls back to the default pair", () => {
    const t = resolveTokens({ ink: "#101010", canvas: "#0b0d11" });
    expect(t.ink).toBe(DEFAULT_TOKENS.ink);
    expect(contrast(t.ink, t.canvas)).toBeGreaterThan(4.5);
    expect(resolveTokens({ ink: "#ffffff", canvas: "#000000" }).ink).toBe("#ffffff");
  });

  it("card styles: solid is opaque, outline has no fill or blur", () => {
    expect(tokensToCss(resolveTokens({ cardStyle: "solid" }))["--cc-card-bg"]).toBe("rgba(24, 28, 38, 0.94)");
    const o = tokensToCss(resolveTokens({ cardStyle: "outline" }));
    expect([o["--cc-card-bg"], o["--cc-glass-blur"]]).toEqual(["rgba(0, 0, 0, 0)", "0px"]);
  });

  it("every built-in theme is valid as written", () => {
    for (const t of BUILTIN_THEMES) expect(sanitizePatch(t.tokens)).toEqual(t.tokens);
  });

  it("safety controls keep every shipped token whatever the theme sets", () => {
    const start = css.indexOf("[data-safety] {");
    const rule = css.slice(start, css.indexOf("}", start));
    for (const [k, v] of Object.entries(tokensToCss(DEFAULT_TOKENS))) expect(rule).toContain(`${k}: ${v};`);
  });

  it("every fs-N / r-N class in the app is one Tailwind generates (steps of 0.25)", () => {
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(tsx?|jsx?)$/.test(e.name))
          for (const m of readFileSync(p, "utf8").matchAll(/(?<![\w-])(?:fs|r)-(\d+(?:\.\d+)?)(?![\w.])/g)) if (Number(m[1]) * 4 !== Math.round(Number(m[1]) * 4)) bad.push(`${p}: ${m[0]}`);
      }
    };
    walk(resolve(__dirname, "../.."));
    expect(bad).toEqual([]);
  });

  it("the shipped glow and button colours are exactly the old ones by default", () => {
    const v = tokensToCss(DEFAULT_TOKENS);
    expect([v["--cc-accent-light-rgb"], v["--cc-accent2-light-rgb"], v["--cc-accent-end"]]).toEqual(["255, 179, 107", "45, 212, 191", "#ff6b4a"]);
  });

  it("colours are checked against the cards text sits on, each on its own", () => {
    const light = resolveTokens({ canvas: "#f5f5f5", ink: "#111111", ink2: "#222222", accent: "#1a1e28" });
    // Dark text on the dark cards would vanish: it falls back; so does an accent the colour of the cards.
    expect([light.ink, light.ink2, light.accent]).toEqual([DEFAULT_TOKENS.ink, DEFAULT_TOKENS.ink2, DEFAULT_TOKENS.accent]);
    expect(contrast(light.ink, light.canvas)).toBeGreaterThanOrEqual(3);
    // Outline cards show the background: dark text on a light background is fine there.
    const outline = resolveTokens({ cardStyle: "outline", canvas: "#f5f5f5", ink: "#111111" });
    expect(outline.ink).toBe("#111111");
  });

  it("inherited names in an import are dropped, not fatal", () => {
    expect(sanitizePatch(JSON.parse('{"constructor":1,"__proto__":{"x":1},"toString":2,"accent":"#112233"}'))).toEqual({ accent: "#112233" });
  });
});

describe("appearance store: Reset to default first", () => {
  beforeEach(() => useAppearance.setState({ themes: [], activeTheme: "default", app: {}, pages: {}, lastReset: null }));
  const S = () => useAppearance.getState();

  it("Reset to default clears theme, app-wide edits and page overrides; Undo brings them back", () => {
    S().applyTheme("midnight");
    S().setToken("radius", 8);
    S().setToken("accent", "#22c55e", "trading");
    S().resetAll();
    expect(resolvedFor(S(), "trading")).toEqual(DEFAULT_TOKENS);
    S().undoReset();
    expect(resolvedFor(S(), "trading")).toMatchObject({ radius: 8, accent: "#22c55e", cardStyle: "solid" });
  });

  it("an edit after a reset settles it: Undo no longer throws the edit away", () => {
    S().setToken("radius", 8);
    S().resetAll();
    S().setToken("accent", "#3b82f6");
    expect(S().lastReset).toBeNull();
  });

  it("a page override applies to that page only; Reset this page drops it", () => {
    S().setToken("accent", "#22c55e", "trading");
    expect(resolvedFor(S(), "trading").accent).toBe("#22c55e");
    expect(resolvedFor(S(), "comms").accent).toBe(DEFAULT_TOKENS.accent);
    S().resetPage("trading");
    expect(S().pages).toEqual({});
  });

  it("clearing a token goes back to the inherited value", () => {
    S().setToken("fontScale", 1.2);
    S().setToken("fontScale", 0.9, "agents");
    S().clearToken("fontScale", "agents");
    expect(resolvedFor(S(), "agents").fontScale).toBe(1.2);
    S().clearToken("fontScale");
    expect(resolvedFor(S()).fontScale).toBe(1);
  });

  it("Save as theme keeps the current look; applying another sets edits aside (Undo returns them)", () => {
    S().applyTheme("outline");
    S().setToken("accent", "#3b82f6");
    const id = S().saveTheme("Mine");
    expect(S().activeTheme).toBe(id);
    expect(S().app).toEqual({});
    expect(resolvedFor(S())).toMatchObject({ cardStyle: "outline", accent: "#3b82f6" });
    expect(diffFromDefault(resolvedFor(S()))).toEqual(S().themes[0].tokens);
    S().setToken("radius", 4);
    S().applyTheme("default");
    expect(resolvedFor(S()).radius).toBe(20);
    S().undoReset();
    expect(resolvedFor(S()).radius).toBe(4);
    S().deleteTheme(id);
    expect(S().activeTheme).toBe("default");
  });

  it("a damaged save loads as defaults, never a crash", () => {
    expect(sanitizeAppearance({ activeTheme: "gone", themes: [{ id: "default", name: "x", tokens: {} }, { id: "ok", tokens: { radius: "x" } }], pages: { "../x": { radius: 3 } } })).toEqual({
      themes: [{ id: "ok", name: "Theme", tokens: {} }],
      activeTheme: "default",
      app: {},
      pages: {},
    });
  });
});

describe("export / import file", () => {
  it("round-trips themes and layouts", () => {
    useAppearance.setState({ themes: [], activeTheme: "large", app: { radius: 6 }, pages: { trading: { accent: "#22c55e" } }, lastReset: null });
    const file = parseUiFile(JSON.stringify(buildUiFile(new Date(0))));
    expect(file.appearance).toMatchObject({ activeTheme: "large", app: { radius: 6 }, pages: { trading: { accent: "#22c55e" } } });
    expect(file.layouts?.home).toBeTruthy();
    useAppearance.getState().resetAll();
    applyUiFile(file, { themes: true, layouts: false }, false);
    expect(useAppearance.getState().activeTheme).toBe("large");
  });

  it("an import that changes nothing keeps the earlier backup", () => {
    expect(applyUiFile(parseUiFile(JSON.stringify({ format: "agentic-os-ui", version: 1 })), { themes: true, layouts: true })).toEqual([]);
  });

  it("rejects other files and newer versions with a readable reason", () => {
    expect(() => parseUiFile("nope")).toThrow(/isn't JSON/);
    expect(() => parseUiFile(JSON.stringify({ hello: 1 }))).toThrow(/isn't an Agentic OS/);
    expect(() => parseUiFile(JSON.stringify({ format: "agentic-os-ui", version: 2 }))).toThrow(/newer/);
  });

  it("sanitises an imported layout: unknown widgets are dropped, bad surface names ignored", () => {
    const file = parseUiFile(
      JSON.stringify({
        format: "agentic-os-ui",
        version: 1,
        layouts: {
          home: { pages: [{ id: "p1", name: "Imported", items: [{ instanceId: "w", widgetId: "weather", col: 1, row: 1, w: 3, h: 2, config: {} }, { instanceId: "z", widgetId: "no-such-widget", col: 5, row: 1, w: 2, h: 2, config: {} }] }], activePage: "p1" },
          "../evil": { pages: [] },
        },
      }),
    );
    expect(Object.keys(file.layouts ?? {})).toEqual(["home"]);
    applyUiFile(file, { themes: false, layouts: true }, false);
    const page = useLayout.getState().pages[0];
    expect(page.name).toBe("Imported");
    expect(page.items.map((i) => i.widgetId)).toEqual(["weather"]);
  });
});

describe("style kit for generated widgets", () => {
  const rust = readFileSync(resolve(__dirname, "../../../src-tauri/src/commands/taskworker.rs"), "utf8");
  const kit = rust.slice(rust.indexOf("pub const STYLE_KIT"), rust.indexOf(String.fromCharCode(10), rust.indexOf("pub const STYLE_KIT")));

  it("the Designer / Coder are told exactly the names and defaults the dashboard posts", () => {
    for (const [k, v] of Object.entries(STYLE_KIT_DEFAULTS)) expect(kit).toContain(`${k}: ${v};`.replace(/;$/, ""));
    expect(kit).toContain("'cc-theme'");
  });

  it("follows the theme", () => {
    const v = styleKitVars(resolveTokens({ accent: "#3b82f6", radius: 12, fontScale: 1.2 }));
    expect([v["--cc-accent"], v["--cc-radius"], v["--cc-font-scale"]]).toEqual(["#3b82f6", "12px", "1.2"]);
  });
});
