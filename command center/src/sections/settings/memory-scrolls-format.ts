/**
 * Phase 3 Memory Scrolls: pure formatting for the Settings "Memory Scrolls" card.
 * No I/O, no secrets (the Rust outcome is already scrubbed and carries no key fields).
 */
import type { CompactOutcome, CompactionStatus, MemoryScrollsConfig } from "@/lib/platform";

/** os_core.rs `DEFAULT_SCROLLS_DIR` (shown when `memory.scrolls.scrollsDir` is empty). */
export const DEFAULT_SCROLLS_DIR = "G:\\ai-hub-memory\\scrolls";

/** os_core.rs `READ_ONLY_HUB_ROOT`: no scrolls dir may live under it. */
export const READ_ONLY_HUB_ROOT = "G:\\ai-hub";

/** os_core.rs `LEGACY_HUB_ROOT`: the hub's old path (now a junction to G:), refused too. */
export const LEGACY_HUB_ROOT = "C:\\ai-hub";

/**
 * Lexical mirror of os_core.rs `under_read_only_hub` (case-insensitive; `/`, `\\?\`, `.` / `..`,
 * and an admin share `\\host\C$\...` of any host mapped back to `C:\...`).
 */
export function underReadOnlyHub(dir: string | null | undefined): boolean {
  let s = (dir ?? "").trim().replace(/\//g, "\\");
  if (!s) return false;
  if (/^\\\\[?.]\\UNC\\/i.test(s)) s = `\\\\${s.slice(8)}`;
  else s = s.replace(/^\\\\[?.]\\/, "");
  s = s.replace(/^\\\\[^\\]+\\([a-z])\$(?=\\|$)\\?/i, "$1:\\");
  const out: string[] = [];
  s.split("\\").forEach((part, i) => {
    if (part === ".") return;
    if (part === "..") {
      if (out.length > 1) out.pop();
      return;
    }
    if (part === "" && i > 0) return;
    out.push(part.replace(/[. ]+$/, "").toLowerCase());
  });
  const key = out.join("\\");
  return [READ_ONLY_HUB_ROOT, LEGACY_HUB_ROOT].some((r) => {
    const root = r.toLowerCase();
    return key === root || key.startsWith(`${root}\\`);
  });
}

/** The scrolls dir the app uses: the configured one, or the default when empty or under `C:\ai-hub`. */
export function effectiveScrollsDir(dir: string | null | undefined): string {
  const d = (dir ?? "").trim();
  return d && !underReadOnlyHub(d) ? d : DEFAULT_SCROLLS_DIR;
}

/** "812 B", "38 KB", "1.2 MB". */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The CLI lists scroll ids for synced / sync_pending / sync_failed; tolerate a bare count too. */
export function countOf(v: readonly unknown[] | number | null | undefined): number {
  if (Array.isArray(v)) return v.length;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** One line for a compaction outcome. */
export function formatOutcome(o: CompactOutcome | null | undefined): string {
  if (!o) return "";
  if (o.deferred) return `Deferred: ${o.deferred}`;
  if (o.error) return `Failed: ${o.error}`;
  const r = o.result ?? {};
  const archives = r.archive_ids ?? [];
  const scrolls = r.scrolls_updated ?? [];
  const synced = countOf(r.synced);
  const pending = countOf(r.sync_pending);
  const failed = countOf(r.sync_failed);
  if (!archives.length && !scrolls.length && !synced && !failed) {
    return (r.pending_targets ?? 0) > 0 ? `Nothing new archived · ${plural(r.pending_targets ?? 0, "target")} still pending` : "Nothing to compact";
  }
  const parts: string[] = [];
  if (archives.length) parts.push(archives.length === 1 ? `Archived ${archives[0]}` : `Archived ${archives.length} batches`);
  parts.push(`${plural(scrolls.length, "scroll")} updated`);
  if (synced > 0 && !pending && !failed) parts.push("synced");
  else if (pending > 0) parts.push(`${pending} sync pending`);
  if (failed > 0) parts.push(`${failed} sync failed`);
  if ((r.pending_targets ?? 0) > 0) parts.push(`${plural(r.pending_targets ?? 0, "target")} pending`);
  if (r.llm === "replay") parts.push("recorded replies");
  return parts.join(" · ");
}

/** How the outcome line is coloured: a failed scroll sync is never shown as a success. */
export function outcomeTone(o: CompactOutcome | null | undefined): "error" | "warn" | "ok" {
  if (!o) return "ok";
  if (o.error || countOf(o.result?.sync_failed) > 0) return "error";
  if (o.deferred || countOf(o.result?.sync_pending) > 0) return "warn";
  return "ok";
}

/** "38 KB / 12 turns pending, threshold 50 KB / 25". */
export function formatPending(s: CompactionStatus | null | undefined): string {
  if (!s) return "";
  if (!s.status) return s.statusError ? `Status unavailable: ${s.statusError}` : "Status unavailable";
  const p = s.status.pending;
  return `${formatBytes(p.bytes)} / ${plural(p.turns, "turn")} pending, threshold ${s.thresholds.kb} KB / ${s.thresholds.turns}`;
}

/** Where the cold archive root came from, in words. */
export function archiveSourceLabel(source: string | null | undefined): string {
  switch (source) {
    case "pinned":
      return "pinned by the first compaction";
    case "flag":
      return "command-line flag";
    case "env":
      return "archive-dir environment variable";
    case ".env":
      return "archive-dir entry in .env";
    case "os.json":
      return "Settings (os.json)";
    case "D:":
      return "secondary drive D:";
    case "fallback":
      return "repo fallback (./archive/memory)";
    default:
      return source || "unknown";
  }
}

/** The button is enabled unless a run is in flight (here or reported by Rust). */
export function canCompact(state: { busy: boolean; status: CompactionStatus | null }): boolean {
  return !state.busy && !state.status?.running;
}

/** Clamp a Settings number input to the Rust bounds (NaN → the fallback). */
export function clampInt(v: string | number, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** Bounds mirrored from os_core.rs `ScrollsConfig`. */
export const SCROLLS_BOUNDS = {
  thresholdKb: [8, 1024],
  thresholdTurns: [5, 500],
  quietMins: [2, 240],
} as const satisfies Partial<Record<keyof MemoryScrollsConfig, readonly [number, number]>>;
