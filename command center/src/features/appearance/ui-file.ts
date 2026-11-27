import { allSurfaceStores } from "@/core/widgets/layout-store";
import { sanitizeAppearance, useAppearance } from "./appearance-store";
import { isTauri } from "@/lib/platform";
import { xcmd } from "@/lib/native-ext";

/**
 * Settings → Appearance → Export / import: layouts and themes as one file, `agentic-os-ui.json`.
 * An import is validated and sanitised (unknown widgets dropped, safety controls kept), and the
 * current state is backed up first so "Restore what was there" undoes it.
 */
export const UI_FILE_FORMAT = "agentic-os-ui";
export const UI_FILE_NAME = "agentic-os-ui.json";
const BACKUP_KEY = "cc.ui.backup";
const SURFACE_ID = /^[a-z0-9-]{1,40}$/;

export interface UiFile {
  format: typeof UI_FILE_FORMAT;
  version: 1;
  exportedAt: string;
  appearance?: ReturnType<typeof sanitizeAppearance>;
  /** Per surface ("home", "playplace", …): its saved layout. */
  layouts?: Record<string, unknown>;
}

/** Layouts saved by pages not opened this session (their store isn't made yet). */
function savedLayouts(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) ?? "";
      const surface = k.startsWith("cc.layout.") ? k.slice("cc.layout.".length) : "";
      if (!SURFACE_ID.test(surface)) continue;
      const state = (JSON.parse(localStorage.getItem(k) ?? "null") as { state?: unknown } | null)?.state;
      if (state && typeof state === "object") out[surface] = state;
    }
  } catch {
    /* storage blocked: the live stores still export */
  }
  return out;
}

/** Everything as it is now. */
export function buildUiFile(now = new Date()): UiFile {
  const a = useAppearance.getState();
  return {
    format: UI_FILE_FORMAT,
    version: 1,
    exportedAt: now.toISOString(),
    appearance: { themes: a.themes, activeTheme: a.activeTheme, app: a.app, pages: a.pages },
    layouts: { ...savedLayouts(), ...Object.fromEntries(allSurfaceStores().map((st) => [st.getState().surface, st.getState().exportLayout()])) },
  };
}

/** Parse and check a file's text; throws a readable error when it isn't one of ours. Pure. */
export function parseUiFile(text: string): UiFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file isn't JSON.");
  }
  const r = raw as Partial<UiFile> | null;
  if (!r || r.format !== UI_FILE_FORMAT) throw new Error("That isn't an Agentic OS layout and theme file.");
  if (r.version !== 1) throw new Error(`File version ${String(r.version)} is newer than this app understands.`);
  const layouts: Record<string, unknown> = {};
  if (r.layouts && typeof r.layouts === "object") for (const [k, v] of Object.entries(r.layouts)) if (SURFACE_ID.test(k) && v && typeof v === "object") layouts[k] = v;
  return {
    format: UI_FILE_FORMAT,
    version: 1,
    exportedAt: typeof r.exportedAt === "string" ? r.exportedAt : "",
    ...(r.appearance ? { appearance: sanitizeAppearance(r.appearance) } : {}),
    ...(Object.keys(layouts).length ? { layouts } : {}),
  };
}

export interface ImportChoice {
  themes: boolean;
  layouts: boolean;
}

/** Apply a parsed file (what `choice` allows), after backing up the current state. Returns what changed. */
export function applyUiFile(file: UiFile, choice: ImportChoice = { themes: true, layouts: true }, backup = true, keepView = false): string[] {
  // Nothing to apply: keep the existing backup (it may be the only way back from an earlier import).
  if (!((choice.themes && file.appearance) || (choice.layouts && file.layouts))) return [];
  if (backup) saveBackup();
  const done: string[] = [];
  if (choice.themes && file.appearance) {
    useAppearance.setState({ ...sanitizeAppearance(file.appearance), lastReset: null });
    done.push("themes");
  }
  if (choice.layouts && file.layouts) {
    const stores = new Map(allSurfaceStores().map((st) => [st.getState().surface, st]));
    for (const [surface, raw] of Object.entries(file.layouts)) {
      const st = stores.get(surface);
      if (st) st.getState().importLayout(raw, { keepView });
      // A page not opened yet this session: saved for it; its store validates it when it loads.
      else writeStorage(`cc.layout.${surface}`, JSON.stringify({ state: raw, version: 1 }));
      done.push(surface);
    }
  }
  return done;
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage full / blocked: the live stores were still updated */
  }
}

function saveBackup() {
  writeStorage(BACKUP_KEY, JSON.stringify(buildUiFile()));
}

/** The state before the last import, if any. */
export function readBackup(): UiFile | null {
  try {
    const t = localStorage.getItem(BACKUP_KEY);
    return t ? parseUiFile(t) : null;
  } catch {
    return null;
  }
}

/** Undo the last import: put the backup back (the state it replaces becomes the new backup). */
export function restoreBackup(): boolean {
  const b = readBackup();
  if (!b) return false;
  applyUiFile(b, { themes: true, layouts: true }, true);
  return true;
}

/**
 * Save the file. Desktop: a native Save dialog (Rust writes only where you pick); returns the
 * path, or null when cancelled. Browser / phone: a normal download (returns "Downloads").
 */
export async function saveUiFile(file: UiFile = buildUiFile()): Promise<string | null> {
  if (isTauri()) return xcmd("ui_file_save", { contents: JSON.stringify(file, null, 2) });
  downloadUiFile(file);
  return "Downloads";
}

function downloadUiFile(file: UiFile): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = UI_FILE_NAME;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
