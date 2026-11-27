import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Download, Palette, RotateCcw, Save, Trash2, Undo2, Upload } from "lucide-react";
import { Card } from "@/components/ui";
import { SECTIONS } from "@/stores/nav";
import { allThemes, resolvedFor, useAppearance } from "@/features/appearance/appearance-store";
import { applyTokens } from "@/features/appearance/install";
import { DEFAULT_TOKENS, OPTIONS_OF, RANGE_OF, type ThemeTokens, type TokenKey } from "@/features/appearance/theme";
import { followDesktop, lastPushError, pullUi, setFollowDesktop } from "@/features/appearance/ui-sync";
import { isDesktopApp } from "@/stores/settings";
import { applyUiFile, saveUiFile, parseUiFile, readBackup, restoreBackup, type UiFile } from "@/features/appearance/ui-file";

/**
 * Settings → Appearance, the control centre (AGENTS.md, "Everything Is Customizable"): every design
 * token with a live preview, app-wide or for one page, saved themes, Reset to default, and the
 * layouts + themes file. Safety controls (kill switches, Tony's stop, confirmations) keep the
 * shipped look whatever is picked here.
 */
export function AppearanceStudio() {
  const [scope, setScope] = useState<string>(""); // "" = the whole app, else a page (nav section id)
  return (
    <>
      <ResetCard />
      <ThemesCard />
      <Card title="Design tokens" hint="Changes show at once, everywhere. Pick a page to give only that page its own value; a dot marks a changed value, its ↺ puts it back.">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="label-caps text-ink-3">Applies to</span>
          <select className="field !h-9 !w-auto !py-1 fs-13" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Which pages these values apply to">
            <option value="">Whole app</option>
            {SECTIONS.map((s) => (
              <option key={s.id} value={s.id}>
                Only {s.label}
              </option>
            ))}
          </select>
          {scope && <PageResetButton page={scope} />}
        </div>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <TokenEditor page={scope || null} />
          <Preview page={scope || null} />
        </div>
      </Card>
      {!isDesktopApp() && <FollowDesktopCard />}
      <FileCard />
    </>
  );
}

/** Reset to default comes first: the whole look, with Undo. */
function ResetCard() {
  const lastReset = useAppearance((s) => s.lastReset);
  const changed = useAppearance((s) => s.activeTheme !== "default" || Object.keys(s.app).length > 0 || Object.keys(s.pages).length > 0);
  return (
    <Card title="Reset to default" hint="Back to the look the app shipped with: the default theme, no app-wide changes, no page overrides. Your saved themes stay. Layouts have their own Reset on each page.">
      <div className="flex flex-wrap items-center gap-2">
        <button className="pill-glass !h-9 fs-13" disabled={!changed} onClick={() => useAppearance.getState().resetAll()}>
          <RotateCcw size={13} /> Reset everything to default
        </button>
        {lastReset && (
          <button className="pill-glass !h-9 !border-teal/60 fs-13 text-teal" onClick={() => useAppearance.getState().undoReset()}>
            <Undo2 size={13} /> Undo
          </button>
        )}
        {!changed && !lastReset && <span className="fs-12 text-ink-3">Everything is at its default.</span>}
      </div>
    </Card>
  );
}

function PageResetButton({ page }: { page: string }) {
  const has = useAppearance((s) => !!s.pages[page]);
  const label = SECTIONS.find((s) => s.id === page)?.label ?? page;
  return (
    <button className="pill-glass !h-9 fs-13" disabled={!has} onClick={() => useAppearance.getState().resetPage(page)} title={`${label} goes back to the app-wide look.`}>
      <RotateCcw size={13} /> Reset {label}
    </button>
  );
}

function ThemesCard() {
  const themes = useAppearance((s) => s.themes);
  const active = useAppearance((s) => s.activeTheme);
  const edited = useAppearance((s) => Object.keys(s.app).length > 0);
  const [name, setName] = useState("");
  const all = allThemes({ themes });
  return (
    <Card title="Themes" hint="Applying a theme sets your app-wide changes aside (Undo brings them back). Save the current look as a theme to keep it.">
      <div className="flex flex-wrap gap-2">
        {all.map((t) => (
          <div key={t.id} className={`flex items-center gap-1 r-12 border px-2 py-1 ${t.id === active ? "border-teal/60 bg-teal/10" : "border-white/10"}`}>
            <button className="flex items-center gap-1.5 fs-13 text-ink" onClick={() => useAppearance.getState().applyTheme(t.id)} aria-pressed={t.id === active}>
              {t.id === active ? <Check size={12} className="text-teal" /> : <Palette size={12} className="text-ink-3" />}
              {t.name}
              {t.id === active && edited && <span className="fs-11 text-amber-soft">(changed)</span>}
            </button>
            {!t.builtin && (
              <>
                {t.id === active && edited && (
                  <button className="grid size-6 place-items-center text-ink-3 hover:text-ink" title="Save the changes into this theme" aria-label={`Update ${t.name}`} onClick={() => useAppearance.getState().updateTheme(t.id)}>
                    <Save size={12} />
                  </button>
                )}
                <button
                  className="grid size-6 place-items-center text-ink-3 hover:text-ink"
                  title="Rename"
                  aria-label={`Rename ${t.name}`}
                  onClick={() => {
                    const n = window.prompt("Theme name", t.name);
                    if (n) useAppearance.getState().renameTheme(t.id, n);
                  }}
                >
                  <span className="fs-11">Aa</span>
                </button>
                <button className="grid size-6 place-items-center text-ink-3 hover:text-alert" title="Delete this theme" aria-label={`Delete ${t.name}`} onClick={() => useAppearance.getState().deleteTheme(t.id)}>
                  <Trash2 size={12} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          useAppearance.getState().saveTheme(name);
          setName("");
        }}
      >
        <input className="field !h-9 !py-1 fs-13" placeholder="Name this look, e.g. “Night shoot”" value={name} onChange={(e) => setName(e.target.value)} aria-label="New theme name" />
        <button className="pill-primary !h-9 shrink-0 !px-3 fs-13" disabled={!name.trim()}>
          <Save size={13} /> Save as theme
        </button>
      </form>
    </Card>
  );
}

const COLORS: [TokenKey, string][] = [
  ["accent", "Accent (actions)"],
  ["accentLight", "Accent, light"],
  ["accent2", "Second accent (healthy, sync)"],
  ["canvas", "Background"],
  ["ink", "Text"],
  ["ink2", "Text, secondary"],
  ["ink3", "Text, faint"],
];
const SLIDERS: [TokenKey, string, number, (v: number) => string][] = [
  ["glassAlpha", "Card opacity", 0.01, (v) => `${Math.round(v * 100)} %`],
  ["glassBlur", "Glass blur", 1, (v) => `${v} px`],
  ["borderWidth", "Border width", 0.5, (v) => `${v} px`],
  ["borderAlpha", "Border brightness", 0.01, (v) => `${Math.round(v * 100)} %`],
  ["radius", "Corner radius", 1, (v) => `${v} px`],
  ["shadow", "Shadow depth", 0.1, (v) => `${Math.round(v * 100)} %`],
  ["fontScale", "Text size", 0.05, (v) => `${Math.round(v * 100)} %`],
  ["density", "Spacing", 0.05, (v) => `${Math.round(v * 100)} %`],
  ["iconStroke", "Icon line weight", 0.25, (v) => v.toFixed(2)],
];
const CHOICES: [TokenKey, string, Record<string, string>][] = [
  ["cardStyle", "Card style", { glass: "Glass", solid: "Solid", outline: "Outline" }],
  ["font", "Font", { jakarta: "Jakarta", system: "System", rounded: "Rounded", serif: "Serif", mono: "Mono" }],
  ["widgetFrame", "New widgets", { glass: "Glass", ultra: "Ultra glass", solid: "Solid", frameless: "Frameless" }],
  ["motion", "Motion", { full: "Full", reduced: "Reduced", off: "Off" }],
];

function TokenEditor({ page }: { page: string | null }) {
  const t = useAppearance((s) => JSON.stringify(resolvedFor(s, page)));
  const own = useAppearance((s) => JSON.stringify(page ? (s.pages[page] ?? {}) : s.app));
  const tokens = JSON.parse(t) as ThemeTokens;
  const mine = JSON.parse(own) as Partial<ThemeTokens>;
  const { setToken, clearToken } = useAppearance.getState();
  const row = (k: TokenKey, label: string, control: ReactNode) => (
    <div key={k} className="flex items-center gap-2 py-1">
      <span className={`size-1.5 shrink-0 rounded-full ${k in mine ? "bg-amber" : "bg-transparent"}`} aria-hidden />
      <span className="w-40 shrink-0 fs-12 text-ink-2">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{control}</div>
      <button className="grid size-6 shrink-0 place-items-center text-ink-3 hover:text-ink disabled:opacity-0" disabled={!(k in mine)} onClick={() => clearToken(k, page)} title="Back to the inherited value" aria-label={`Reset ${label}`}>
        <RotateCcw size={11} />
      </button>
    </div>
  );
  return (
    <div className="min-w-0 space-y-3">
      <Group title="Colours">
        {COLORS.map(([k, label]) =>
          row(k, label, <input type="color" value={tokens[k] as string} onChange={(e) => setToken(k, e.target.value as never, page)} className="h-7 w-12 r-6 border border-white/10 bg-transparent" aria-label={label} />),
        )}
        <p className="pl-3.5 fs-11 text-ink-3">Text that would be hard to read on the background falls back to the default colours.</p>
      </Group>
      <Group title="Cards, glass and shape">
        {CHOICES.slice(0, 1).map(([k, label, opts]) => row(k, label, <Segments k={k} opts={opts} value={tokens[k] as string} page={page} label={label} />))}
        {SLIDERS.slice(0, 6).map(([k, label, step, fmt]) => row(k, label, <Slider k={k} step={step} fmt={fmt} value={tokens[k] as number} page={page} label={label} />))}
      </Group>
      <Group title="Type, spacing and icons">
        {CHOICES.slice(1, 2).map(([k, label, opts]) => row(k, label, <Segments k={k} opts={opts} value={tokens[k] as string} page={page} label={label} />))}
        {SLIDERS.slice(6).map(([k, label, step, fmt]) => row(k, label, <Slider k={k} step={step} fmt={fmt} value={tokens[k] as number} page={page} label={label} />))}
      </Group>
      <Group title="Widgets and motion">
        {CHOICES.slice(2).map(([k, label, opts]) => row(k, label, <Segments k={k} opts={opts} value={tokens[k] as string} page={page} label={label} />))}
      </Group>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="label-caps mb-1 text-amber-soft">{title}</h3>
      {children}
    </section>
  );
}

function Segments({ k, opts, value, page, label }: { k: TokenKey; opts: Record<string, string>; value: string; page: string | null; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {(OPTIONS_OF[k] ?? Object.keys(opts)).map((o) => (
        <button
          key={o}
          className={`rounded-full border px-2.5 py-1 fs-11 ${value === o ? "border-teal/60 bg-teal/15 text-teal" : "border-white/10 text-ink-2 hover:text-ink"}`}
          aria-pressed={value === o}
          onClick={() => useAppearance.getState().setToken(k, o as never, page)}
        >
          {opts[o] ?? o}
        </button>
      ))}
    </div>
  );
}

function Slider({ k, step, fmt, value, page, label }: { k: TokenKey; step: number; fmt: (v: number) => string; value: number; page: string | null; label: string }) {
  const [lo, hi] = RANGE_OF[k];
  return (
    <>
      <input type="range" min={lo} max={hi} step={step} value={value} onChange={(e) => useAppearance.getState().setToken(k, Number(e.target.value) as never, page)} className="min-w-0 flex-1" aria-label={label} />
      <span className="w-14 text-right font-mono fs-11 text-ink-3 tabular">{fmt(value)}</span>
    </>
  );
}

/** A sample page drawn with the tokens of the chosen scope (so a page's own look previews here too). */
function Preview({ page }: { page: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const t = useAppearance((s) => JSON.stringify(resolvedFor(s, page)));
  useEffect(() => {
    if (box.current) applyTokens(box.current, JSON.parse(t) as ThemeTokens);
  }, [t]);
  const tokens = JSON.parse(t) as ThemeTokens;
  return (
    <div ref={box} className="space-y-3 r-18 p-3" style={{ background: tokens.canvas, fontFamily: "var(--font-sans)", color: "var(--color-ink)" }} aria-label="Live preview">
      <p className="label-caps text-ink-3">Live preview{page ? ` · ${SECTIONS.find((s) => s.id === page)?.label}` : ""}</p>
      <div className="glass r-20 p-4">
        <div className="flex items-center gap-2">
          <Palette size={14} className="text-teal" />
          <span className="label-caps text-amber-soft">Widget card</span>
        </div>
        <p className="mt-2 fs-15 text-ink">Tony booked the studio for Friday.</p>
        <p className="fs-12 text-ink-2">Secondary text · 3 min ago</p>
        <p className="fs-11 text-ink-3">Faint hint text</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <span className="pill-primary !h-8 !px-3 fs-12">Primary</span>
          <span className="pill-glass !h-8 !px-3 fs-12">Secondary</span>
        </div>
        <input className="field mt-3 !h-9 !py-1 fs-13" placeholder="A text field" readOnly />
      </div>
      <div className="flex gap-2">
        <div className="well flex-1 r-14 p-2 fs-12 text-ink-2">Recessed tray</div>
        <div className="glass-thin flex-1 r-14 p-2 fs-12 text-teal">Top-bar glass</div>
      </div>
      {tokens.motion !== "full" && <p className="fs-11 text-ink-3">Motion: {tokens.motion === "off" ? "off (loops stopped)" : "reduced"}.</p>}
      {JSON.stringify(tokens) === JSON.stringify(DEFAULT_TOKENS) && <p className="fs-11 text-ink-3">All defaults.</p>}
    </div>
  );
}

/** Phone / browser: follow the desktop's layouts and themes (on by default). */
function FollowDesktopCard() {
  const [on, setOn] = useState(followDesktop);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Card title="Follow the desktop" hint="The desktop shares its layouts (every page and mode) and themes through the gateway. With this on, this device takes the desktop's newest copy when it opens and every minute; panels it can't show are left out. Turn it off to keep this device's own layout.">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 fs-13 text-ink">
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => {
              setFollowDesktop(e.target.checked);
              setOn(e.target.checked);
              setMsg(null);
            }}
          />{" "}
          Follow the desktop's layouts and themes
        </label>
        {on && (
          <button
            className="pill-glass !h-8 !px-3 fs-12"
            onClick={() =>
              void pullUi()
                .then((done) => setMsg(done.length ? `Updated: ${done.join(", ")}.` : "Already up to date."))
                .catch((e) => setMsg(e instanceof Error ? e.message : String(e)))
            }
          >
            Check now
          </button>
        )}
      </div>
      {msg && <p className="mt-2 fs-12 text-ink-2">{msg}</p>}
    </Card>
  );
}

function FileCard() {
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<UiFile | null>(null);
  const [choice, setChoice] = useState({ themes: true, layouts: true });
  const [hasBackup, setHasBackup] = useState(() => !!readBackup());
  const input = useRef<HTMLInputElement>(null);
  return (
    <Card title="Export and import" hint="Your layouts (every page, every mode) and themes as one file, agentic-os-ui.json. Importing checks the file, drops widgets this app doesn't have, keeps the safety controls, and backs up what's there first.">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="pill-glass !h-9 fs-13"
          onClick={() =>
            void saveUiFile()
              .then((where) => setMsg(where ? `Saved agentic-os-ui.json (${where}).` : "Export cancelled."))
              .catch((e) => setMsg(e instanceof Error ? e.message : String(e)))
          }
        >
          <Download size={13} /> Export layouts and themes
        </button>
        <button className="pill-glass !h-9 fs-13" onClick={() => input.current?.click()}>
          <Upload size={13} /> Import a file…
        </button>
        {hasBackup && (
          <button className="pill-glass !h-9 fs-13" onClick={() => setMsg(restoreBackup() ? "Restored what was there before the last import." : "No backup to restore.")} title="Undo the last import">
            <Undo2 size={13} /> Restore what was there before
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            if (f.size > 2_000_000) return setMsg("That file is too big to be a layout file.");
            try {
              setPending(parseUiFile(await f.text()));
              setMsg(null);
            } catch (err) {
              setMsg(err instanceof Error ? err.message : String(err));
            }
          }}
        />
      </div>
      {pending && (
        <div className="mt-3 space-y-2 r-12 border border-amber/40 bg-amber/5 p-3 fs-13" role="dialog" aria-label="Import this file?">
          <p className="text-ink">
            Import this file{pending.exportedAt ? ` (exported ${new Date(pending.exportedAt).toLocaleString()})` : ""}? It replaces what you choose below.
          </p>
          <label className="flex items-center gap-2 text-ink-2">
            <input type="checkbox" checked={choice.themes} disabled={!pending.appearance} onChange={(e) => setChoice((c) => ({ ...c, themes: e.target.checked }))} /> Themes and appearance
          </label>
          <label className="flex items-center gap-2 text-ink-2">
            <input type="checkbox" checked={choice.layouts} disabled={!pending.layouts} onChange={(e) => setChoice((c) => ({ ...c, layouts: e.target.checked }))} /> Layouts ({Object.keys(pending.layouts ?? {}).join(", ") || "none in this file"})
          </label>
          <div className="flex gap-2">
            <button
              className="pill-primary !h-8 !px-3 fs-12"
              onClick={() => {
                const done = applyUiFile(pending, choice);
                setPending(null);
                if (done.length) setHasBackup(true);
                setMsg(done.length ? `Imported: ${done.join(", ")}. Your previous state is backed up.` : "Nothing was imported.");
              }}
            >
              Import
            </button>
            <button className="pill-glass !h-8 !px-3 fs-12" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {msg && <p className="mt-2 fs-12 text-ink-2">{msg}</p>}
      {isDesktopApp() && lastPushError() && <p className="mt-2 fs-12 text-amber-soft">Phone sync: {lastPushError()}</p>}
    </Card>
  );
}
