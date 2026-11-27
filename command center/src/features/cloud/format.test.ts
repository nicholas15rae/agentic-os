import { describe, expect, it } from "vitest";
import type { MediaProject, VerifiedRender } from "@/features/director/contract";
import type { CloudSyncRecord, CloudTransfer } from "./contract";
import { baseName, formatBytes, formatDims, formatDuration, itemMeta, progressPct, transferLine } from "./format";
import { pruneTransfers, pushRecordFor, pushTransferFor, recentRenders, samePath } from "./match";

describe("formatBytes", () => {
  it("scales by 1024 with sensible precision", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(12.34 * 1024 * 1024)).toBe("12.3 MB");
    expect(formatBytes(150 * 1024 * 1024)).toBe("150 MB");
    expect(formatBytes(1.2345 * 1024 ** 3)).toBe("1.23 GB");
  });
  it("unknown → dash", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("m:ss and h:mm:ss", () => {
    expect(formatDuration(5)).toBe("0:05");
    expect(formatDuration(127.4)).toBe("2:07");
    expect(formatDuration(3723)).toBe("1:02:03");
  });
  it("unknown → empty", () => {
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(-3)).toBe("");
  });
});

describe("progressPct", () => {
  it("clamps and never divides by zero", () => {
    expect(progressPct(0, 0)).toBe(0);
    expect(progressPct(50, 200)).toBe(25);
    expect(progressPct(199, 200)).toBe(99);
    expect(progressPct(300, 200)).toBe(100);
    expect(progressPct(-5, 200)).toBe(0);
    expect(progressPct(Number.NaN, 10)).toBe(0);
  });
});

describe("item and transfer lines", () => {
  it("joins the known parts", () => {
    expect(formatDims(1920, 1080)).toBe("1920×1080");
    expect(formatDims(null, 1080)).toBe("");
    expect(itemMeta({ sizeBytes: 2048, durationSec: 65, width: 1080, height: 1920 })).toBe("2.0 KB · 1:05 · 1080×1920");
    expect(itemMeta({ sizeBytes: null, durationSec: null, width: null, height: null })).toBe("");
    expect(transferLine({ bytesDone: 1024 * 1024, bytesTotal: 4 * 1024 * 1024 })).toBe("1.0 MB of 4.0 MB · 25%");
    expect(baseName("C:\\media\\renders\\a_v001.mp4")).toBe("a_v001.mp4");
  });
});

const render = (id: string, createdAt: string, path = `C:\\ai-hub\\media\\projects\\demo\\renders\\${id}.mp4`): VerifiedRender => ({
  id,
  project: "demo",
  planId: "p-1",
  path,
  durationSec: 10,
  width: 1920,
  height: 1080,
  sizeBytes: 1000,
  loudnessLufs: -18,
  verify: { ok: true, checks: [] },
  createdAt,
});
const proj = (slug: string, title: string): MediaProject => ({ slug, title, status: "editing", root: "", createdAt: "", updatedAt: "", source: { from: "suite", refId: null, brief: null }, brief: null, speed: "rough" });
const xfer = (p: Partial<CloudTransfer>): CloudTransfer => ({ id: "x-1", provider: "gdrive", direction: "push", name: "r1.mp4", project: "demo", status: "running", bytesDone: 0, bytesTotal: 10, error: null, result: null, startedAt: "2026-11-22T10:00:00Z", ...p });
const rec = (p: Partial<CloudSyncRecord>): CloudSyncRecord => ({ id: "d1", provider: "gdrive", direction: "push", project: "demo", localPath: "", driveFileId: "f1", name: "r1.mp4", sizeBytes: 1, webViewLink: null, at: "2026-11-22T10:00:00Z", ...p });

describe("matching", () => {
  it("samePath ignores case and separator style", () => {
    expect(samePath("C:\\A\\b.mp4", "c:/a/B.mp4")).toBe(true);
    expect(samePath("C:\\A\\b.mp4", "C:\\A\\c.mp4")).toBe(false);
  });
  it("pushRecordFor picks the newest push row for the path, never a pull", () => {
    const r = render("r1", "t");
    const hist = [rec({ id: "old", localPath: r.path, at: "2026-11-01" }), rec({ id: "new", localPath: r.path.toLowerCase(), at: "2026-11-20" }), rec({ id: "pull", direction: "pull", localPath: r.path, at: "2026-11-30" })];
    expect(pushRecordFor(r.path, hist)?.id).toBe("new");
    expect(pushRecordFor("C:\\other.mp4", hist)).toBeNull();
  });
  it("pushTransferFor prefers this session's transfer id, else name + project", () => {
    const r = render("r1", "t");
    const map = { "x-1": xfer({ id: "x-1", startedAt: "1" }), "x-2": xfer({ id: "x-2", startedAt: "2" }), "x-3": xfer({ id: "x-3", project: "other", startedAt: "3" }) };
    expect(pushTransferFor(r, map, "x-1")?.id).toBe("x-1");
    expect(pushTransferFor(r, map)?.id).toBe("x-2");
    expect(pushTransferFor(render("zz", "t"), map)).toBeNull();
  });
  it("recentRenders flattens projects newest first and caps", () => {
    const rows = recentRenders(
      [
        { project: proj("a", "A"), renders: [render("a1", "2026-11-01"), render("a2", "2026-11-03")] },
        { project: proj("b", "B"), renders: [render("b1", "2026-11-02")] },
      ],
      2,
    );
    expect(rows.map((r) => [r.render.id, r.projectTitle])).toEqual([
      ["a2", "A"],
      ["b1", "B"],
    ]);
  });
  it("pruneTransfers keeps every live one and the newest finished", () => {
    const map: Record<string, CloudTransfer> = {};
    for (let i = 0; i < 5; i++) map[`d${i}`] = xfer({ id: `d${i}`, status: "done", startedAt: `2026-11-0${i + 1}` });
    map.live = xfer({ id: "live", status: "running", startedAt: "2026-01-01" });
    const kept = pruneTransfers(map, 2);
    expect(Object.keys(kept).sort()).toEqual(["d3", "d4", "live"]);
  });
});
