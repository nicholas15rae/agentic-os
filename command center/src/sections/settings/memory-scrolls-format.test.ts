import { describe, expect, it } from "vitest";
import type { CompactOutcome, CompactionStatus, MemoryScrollsConfig, ScrollsStatus } from "@/lib/platform";
import { archiveSourceLabel, canCompact, clampInt, countOf, DEFAULT_SCROLLS_DIR, effectiveScrollsDir, formatBytes, formatOutcome, formatPending, outcomeTone, SCROLLS_BOUNDS, underReadOnlyHub } from "./memory-scrolls-format";

const outcome = (o: Partial<CompactOutcome>): CompactOutcome => ({ manual: true, at: 1, ...o });

const scrollsStatus = (o: Partial<ScrollsStatus> = {}): ScrollsStatus => ({
  pending: { bytes: 38 * 1024, turns: 12, records: 14 },
  threshold: { kb: 50, turns: 25 },
  threshold_hit: false,
  archive_root: "D:\\ai-hub-archive",
  archive_root_source: "D:",
  pinned: null,
  scrolls_root: "C:\\ai-hub\\memory\\scrolls",
  scrolls: [],
  undistilled: [],
  unsynced: [],
  last_run: null,
  lm: { loaded_model: null },
  warnings: [],
  ...o,
});

const status = (o: Partial<CompactionStatus> = {}): CompactionStatus => ({
  status: scrollsStatus(),
  statusError: null,
  auto: false,
  embedOnly: false,
  workspace: "librarian",
  thresholds: { kb: 50, turns: 25 },
  quietMins: 10,
  lastResult: null,
  running: false,
  idleReason: null,
  ...o,
});

describe("formatOutcome", () => {
  it("summarises a finished run", () => {
    expect(
      formatOutcome(outcome({ exit: 0, result: { archive_ids: ["arch-2026-11-19-01"], scrolls_updated: [{ id: "proj-agentic-os", version: 1, bytes: 900 }, { id: "core-architecture-decisions", version: 2, bytes: 1200 }], synced: ["proj-agentic-os", "core-architecture-decisions"], sync_pending: [], sync_failed: [], llm: "live" } })),
    ).toBe("Archived arch-2026-11-19-01 · 2 scrolls updated · synced");
    expect(formatOutcome(outcome({ result: { archive_ids: ["a", "b"], scrolls_updated: [{ id: "x", version: 1, bytes: 1 }], synced: [], sync_pending: ["x"] } }))).toBe("Archived 2 batches · 1 scroll updated · 1 sync pending");
    expect(formatOutcome(outcome({ result: { archive_ids: ["a"], scrolls_updated: [], pending_targets: 2, llm: "replay" } }))).toBe("Archived a · 0 scrolls updated · 2 targets pending · recorded replies");
  });

  it("says when there is nothing to do", () => {
    expect(formatOutcome(outcome({ result: { archive_ids: [], scrolls_updated: [], synced: [], sync_pending: [], sync_failed: [] } }))).toBe("Nothing to compact");
    expect(formatOutcome(outcome({ result: {} }))).toBe("Nothing to compact");
    expect(formatOutcome(outcome({ result: { pending_targets: 1 } }))).toBe("Nothing new archived · 1 target still pending");
  });

  it("reads the CLI's real list-shaped sync fields (compact.py emits scroll ids)", () => {
    // The exact shape `memory_scrolls compact --json` prints.
    const real = { archive_ids: [], scrolls_updated: [], kg_entities_upserted: 0, synced: [], sync_pending: [], sync_failed: [], pending_targets: 0, llm_calls: 0, llm: "live" as const };
    expect(formatOutcome(outcome({ exit: 0, result: real }))).toBe("Nothing to compact");
    const ok = { ...real, archive_ids: ["arch-2026-11-19-01"], scrolls_updated: [{ id: "proj-agentic-os", version: 2, bytes: 900 }], synced: ["proj-agentic-os"] };
    expect(formatOutcome(outcome({ exit: 0, result: ok }))).toBe("Archived arch-2026-11-19-01 · 1 scroll updated · synced");
    expect(outcomeTone(outcome({ exit: 0, result: ok }))).toBe("ok");
    const failed = { ...ok, synced: [], sync_failed: ["proj-agentic-os: HTTP 500"] };
    expect(formatOutcome(outcome({ exit: 0, result: failed }))).toBe("Archived arch-2026-11-19-01 · 1 scroll updated · 1 sync failed");
    expect(outcomeTone(outcome({ exit: 0, result: failed }))).toBe("error");
    // A sync retry that only failed (nothing archived or written this run) is still reported.
    expect(formatOutcome(outcome({ exit: 0, result: { ...real, sync_failed: ["proj-x: HTTP 500"] } }))).toBe("0 scrolls updated · 1 sync failed");
    const pending = { ...ok, synced: [], sync_pending: ["proj-agentic-os", "core-identity-and-preferences"] };
    expect(formatOutcome(outcome({ exit: 0, result: pending }))).toBe("Archived arch-2026-11-19-01 · 1 scroll updated · 2 sync pending");
    expect(outcomeTone(outcome({ exit: 0, result: pending }))).toBe("warn");
    expect(outcomeTone(outcome({ error: "x" }))).toBe("error");
    expect(outcomeTone(outcome({ deferred: "voice active" }))).toBe("warn");
    expect(countOf(["a", "b"])).toBe(2);
    expect(countOf(3)).toBe(3);
    expect(countOf(undefined)).toBe(0);
  });

  it("shows deferrals and errors, never throws", () => {
    expect(formatOutcome(outcome({ deferred: "voice active" }))).toBe("Deferred: voice active");
    expect(formatOutcome(outcome({ deferred: "yielded to foreground" }))).toBe("Deferred: yielded to foreground");
    expect(formatOutcome(outcome({ error: "timed out after 15 minutes" }))).toBe("Failed: timed out after 15 minutes");
    expect(formatOutcome(null)).toBe("");
    expect(formatOutcome(undefined)).toBe("");
  });
});

describe("formatPending", () => {
  it("compares pending against the thresholds", () => {
    expect(formatPending(status())).toBe("38 KB / 12 turns pending, threshold 50 KB / 25");
    expect(formatPending(status({ status: scrollsStatus({ pending: { bytes: 300, turns: 1, records: 1 } }) }))).toBe("300 B / 1 turn pending, threshold 50 KB / 25");
  });
  it("reports a missing status", () => {
    expect(formatPending(status({ status: null, statusError: "could not start python" }))).toBe("Status unavailable: could not start python");
    expect(formatPending(status({ status: null }))).toBe("Status unavailable");
    expect(formatPending(null)).toBe("");
  });
});

describe("helpers", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024 + 200_000)).toBe("3.2 MB");
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });

  it("labels archive root sources", () => {
    expect(archiveSourceLabel("D:")).toBe("secondary drive D:");
    expect(archiveSourceLabel("fallback")).toContain("repo fallback");
    expect(archiveSourceLabel("pinned")).toContain("pinned");
    expect(archiveSourceLabel("env")).toContain("environment");
    expect(archiveSourceLabel(".env")).toContain(".env");
    expect(archiveSourceLabel(undefined)).toBe("unknown");
  });

  it("disables the button while a run is in flight", () => {
    expect(canCompact({ busy: false, status: status() })).toBe(true);
    expect(canCompact({ busy: true, status: status() })).toBe(false);
    expect(canCompact({ busy: false, status: status({ running: true }) })).toBe(false);
    expect(canCompact({ busy: false, status: null })).toBe(true);
  });

  it("clamps setting inputs to the Rust bounds", () => {
    const [lo, hi] = SCROLLS_BOUNDS.thresholdKb;
    expect(clampInt("4", lo, hi, 50)).toBe(8);
    expect(clampInt("99999", lo, hi, 50)).toBe(1024);
    expect(clampInt("abc", lo, hi, 50)).toBe(50);
    expect(clampInt(12.6, ...SCROLLS_BOUNDS.quietMins, 10)).toBe(13);
  });
});

describe("types carry no secrets", () => {
  it("has no key / token fields in the config, outcome or status types", () => {
    const cfg: MemoryScrollsConfig = { scrollsDir: "", archiveDir: "", workspace: "librarian", embedOnly: false, autoCompact: false, thresholdKb: 50, thresholdTurns: 25, quietMins: 10, checkSecs: 300, maxBatchesAuto: 1 };
    const fixtures: object[] = [cfg, outcome({ result: { archive_ids: [] } }), status()];
    const keys = (o: unknown): string[] => (o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => [k, ...keys(v)]) : []);
    for (const f of fixtures) {
      for (const k of keys(f)) expect(k.toLowerCase()).not.toMatch(/key|token|secret|password/);
    }
  });
});

describe("scrolls dir (D:\\ai-hub-memory default, C:\\ai-hub refused)", () => {
  it("defaults to the D: memory root", () => {
    expect(DEFAULT_SCROLLS_DIR).toBe("D:\\ai-hub-memory\\scrolls");
    expect(effectiveScrollsDir("")).toBe(DEFAULT_SCROLLS_DIR);
    expect(effectiveScrollsDir(undefined)).toBe(DEFAULT_SCROLLS_DIR);
    expect(effectiveScrollsDir("  E:/scrolls  ")).toBe("E:/scrolls");
  });

  it("refuses any dir under the read-only C:\\ai-hub, however it is spelled", () => {
    const refused = [
      "C:\\ai-hub",
      "C:\\ai-hub\\memory\\scrolls",
      "c:/AI-HUB/memory/scrolls/",
      "C:\\x\\..\\ai-hub\\memory",
      "\\\\?\\C:\\ai-hub\\memory",
      "\\\\.\\C:\\AI-hub\\memory",
      "C:\\ai-hub.\\memory",
      // The admin share of C: on any host (and its extended-length UNC form).
      "\\\\localhost\\C$\\ai-hub\\memory\\scrolls",
      "\\\\127.0.0.1\\c$\\ai-hub\\m",
      "//localhost/c$/ai-hub/m",
      "\\\\?\\UNC\\localhost\\c$\\ai-hub\\m",
      "\\\\Server\\C$\\AI-HUB",
      "\\\\localhost\\c$\\x\\..\\ai-hub\\memory",
    ];
    for (const d of refused) {
      expect(underReadOnlyHub(d), d).toBe(true);
      expect(effectiveScrollsDir(d), d).toBe(DEFAULT_SCROLLS_DIR);
    }
    for (const d of [
      "C:\\ai-hub2\\scrolls",
      "C:\\ai-hubx",
      "D:\\ai-hub-memory\\scrolls",
      "D:\\ai-hub\\memory",
      "",
      "\\\\localhost\\c$\\ai-hub2",
      "\\\\localhost\\d$\\ai-hub-memory\\scrolls",
      "\\\\localhost\\c$",
      "\\\\server\\share\\ai-hub",
    ]) {
      expect(underReadOnlyHub(d), d).toBe(false);
    }
  });
});
