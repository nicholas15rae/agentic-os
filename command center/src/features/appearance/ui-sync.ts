import { allSurfaceStores, onSurfaceCreated } from "@/core/widgets/layout-store";
import { getWidget } from "@/core/widgets/registry";
import { cc } from "@/lib/cc-api";
import { platform, type Platform } from "@/lib/platform";
import { useAppearance } from "./appearance-store";
import { applyUiFile, buildUiFile, parseUiFile, type UiFile } from "./ui-file";

/**
 * Layout step 6, phone sync (AGENTS.md: layouts "sync to the phone where the screen allows"):
 * the desktop app pushes its layouts (every page, every mode) and themes to the gateway as one
 * `agentic-os-ui` file under the kv key `ui.shared`; the phone (PWA or Android app) pulls it when
 * it opens, when it comes back to the front and every minute, and applies a newer copy the same
 * way an import does (validated, safety controls kept). Panels the phone can't show are dropped;
 * the phone shows them in its own column order (it ignores grid positions it can't use).
 *
 * One-way: the desktop is the source. The phone can turn "Follow the desktop" off to keep its own.
 */
export const UI_SYNC_KEY = "ui.shared";
const FOLLOW_KEY = "cc.ui.follow";
const LAST_KEY = "cc.ui.sync.rev";
const PUSHED_KEY = "cc.ui.sync.pushed";
const ERROR_KEY = "cc.ui.sync.error";
/** The gateway refuses a kv body over 256 KB, measured as Python's json.dumps (spaces, \u escapes). */
export const UI_SYNC_MAX = 256 * 1024;

export interface SyncedUi {
  /** A hash of the content: the phone applies a copy whose revision differs (no clocks compared). */
  rev: string;
  /** When the desktop pushed it (shown only). */
  at: number;
  file: UiFile;
}

/** A short, stable hash of a string (FNV-1a, 52 bits). Pure. */
export function revOf(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `${h1.toString(36)}${(h2 & 0xfffff).toString(36)}`;
}

/** The content a revision covers: the file without its export time. Pure. */
export const contentOf = (file: UiFile) => JSON.stringify({ ...file, exportedAt: "" });

/** Apply only a copy whose revision differs from the last one applied. Pure. */
export function isNewer(remoteRev: unknown, lastRev: string): remoteRev is string {
  return typeof remoteRev === "string" && remoteRev.length > 0 && remoteRev !== lastRev;
}

/** The size the gateway measures: Python json.dumps adds ", " / ": " and escapes non-ASCII as \uXXXX. Pure. */
export function gatewaySize(value: unknown): number {
  const s = JSON.stringify({ value });
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c > 0x7e ? 6 : c === 0x2c || c === 0x3a ? 2 : 1;
  }
  return n;
}

/** A layout without the panels this platform can't show (a desktop-only staging hub on the phone). Pure. */
export function forPlatform(layout: unknown, on: Platform, platformsOf: (widgetId: string) => readonly string[] | undefined): unknown {
  const keep = (items: unknown) =>
    Array.isArray(items)
      ? items.filter((i) => {
          const id = (i as { widgetId?: unknown })?.widgetId;
          const p = typeof id === "string" ? platformsOf(id) : undefined;
          return !p || p.includes(on);
        })
      : items;
  const strip = (s: unknown) => {
    const st = s as { pages?: { items?: unknown }[] } | null;
    if (!st || !Array.isArray(st.pages)) return s;
    return { ...st, pages: st.pages.map((p) => ({ ...p, items: keep(p?.items) })) };
  };
  const top = strip(layout) as { variants?: Record<string, unknown> } | null;
  if (top && top.variants && typeof top.variants === "object") return { ...top, variants: Object.fromEntries(Object.entries(top.variants).map(([k, v]) => [k, strip(v)])) };
  return top;
}

export function followDesktop(): boolean {
  try {
    return localStorage.getItem(FOLLOW_KEY) !== "off";
  } catch {
    return true;
  }
}
export function setFollowDesktop(on: boolean): void {
  try {
    localStorage.setItem(FOLLOW_KEY, on ? "on" : "off");
    // Turning it back on takes the desktop's current copy at the next pull.
    if (on) localStorage.removeItem(LAST_KEY);
  } catch {
    /* storage blocked */
  }
}
const read = (k: string) => {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage blocked */
  }
};

/** Desktop: why the last push was refused ("" when it went through). Shown in Settings → Appearance. */
export const lastPushError = () => read(ERROR_KEY);

/** Desktop: push the current layouts and themes when they changed. "same" | "pushed" | "too-large". */
export async function pushUi(now = Date.now()): Promise<"same" | "pushed" | "too-large"> {
  const file = buildUiFile(new Date(now));
  const rev = revOf(contentOf(file));
  // Only saved content counts: a click, a window or a page switch changes nothing here.
  if (rev === read(PUSHED_KEY)) return "same";
  const value: SyncedUi = { rev, at: now, file };
  if (gatewaySize(value) > UI_SYNC_MAX) {
    write(ERROR_KEY, "Your layouts and themes are too large to share with the phone (over 256 KB). Remove unused pages or mode layouts.");
    return "too-large";
  }
  try {
    await cc.kvSet(UI_SYNC_KEY, value);
  } catch (e) {
    write(ERROR_KEY, `The gateway refused the phone copy: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
  write(PUSHED_KEY, rev);
  write(ERROR_KEY, null);
  return "pushed";
}

/** Phone: pull and apply the desktop's copy if it changed. Returns what was applied. */
export async function pullUi(): Promise<string[]> {
  if (!followDesktop()) return [];
  // Never under your hands: while a page is in Edit layout, the next pull applies it.
  if (allSurfaceStores().some((st) => st.getState().editing)) return [];
  const { value } = await cc.kvGet<SyncedUi>(UI_SYNC_KEY);
  if (!value || !isNewer(value.rev, read(LAST_KEY))) return [];
  const file = parseUiFile(JSON.stringify(value.file));
  const layouts = file.layouts ? Object.fromEntries(Object.entries(file.layouts).map(([k, v]) => [k, forPlatform(v, platform, (id) => getWidget(id)?.platforms)])) : undefined;
  // No backup (the phone's previous state is the desktop's previous copy); keep the phone's view.
  const done = applyUiFile({ ...file, ...(layouts ? { layouts } : {}) }, { themes: true, layouts: true }, false, true);
  write(LAST_KEY, value.rev);
  return done;
}

/** Desktop: push a few seconds after any layout or theme change. Returns the uninstaller. */
export function installUiPush(delayMs = 5000): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(t);
    t = setTimeout(() => void pushUi().catch(() => undefined), delayMs);
  };
  const offs = [useAppearance.subscribe(schedule), ...allSurfaceStores().map((s) => s.subscribe(schedule))];
  // Pages opened later (their store is made on first visit) push too.
  offs.push(onSurfaceCreated((s) => offs.push(s.subscribe(schedule))));
  schedule();
  return () => {
    clearTimeout(t);
    offs.forEach((o) => o());
  };
}

/** Phone: pull on start, when back in front, and every minute while visible. Returns the uninstaller. */
export function installUiPull(everyMs = 60_000): () => void {
  const pull = () => void pullUi().catch(() => undefined);
  pull();
  const onVis = () => document.visibilityState === "visible" && pull();
  document.addEventListener("visibilitychange", onVis);
  const t = setInterval(() => document.visibilityState === "visible" && pull(), everyMs);
  return () => {
    document.removeEventListener("visibilitychange", onVis);
    clearInterval(t);
  };
}
