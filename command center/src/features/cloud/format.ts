/** Pure display helpers for the cloud UI. */

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** 1024-based size: "512 B", "1.5 KB", "12.3 MB", "1.24 GB". Null/invalid → "—". */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "—";
  let v = n;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  if (u === 0) return `${Math.round(v)} B`;
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(u >= 3 ? 2 : 1)} ${UNITS[u]}`;
}

/** Clock duration: "0:05", "2:07", "1:02:03". Null/invalid → "". */
export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "";
  const t = Math.round(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Whole-number progress 0–100; an unknown or zero total is 0, never NaN. */
export function progressPct(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((done / total) * 100)));
}

/** "1920×1080" or "" when either side is unknown. */
export function formatDims(w: number | null | undefined, h: number | null | undefined): string {
  return w && h ? `${w}×${h}` : "";
}

/** The metadata line of a Drive item: size · duration · WxH (empty parts dropped). */
export function itemMeta(i: { sizeBytes: number | null; durationSec: number | null; width: number | null; height: number | null }): string {
  return [i.sizeBytes != null ? formatBytes(i.sizeBytes) : "", formatDuration(i.durationSec), formatDims(i.width, i.height)].filter(Boolean).join(" · ");
}

/** "3.1 MB of 12.0 MB · 25%" for a live transfer. */
export function transferLine(t: { bytesDone: number; bytesTotal: number }): string {
  return t.bytesTotal > 0 ? `${formatBytes(t.bytesDone)} of ${formatBytes(t.bytesTotal)} · ${progressPct(t.bytesDone, t.bytesTotal)}%` : formatBytes(t.bytesDone);
}

export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
