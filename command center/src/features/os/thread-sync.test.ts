import { describe, expect, it, vi } from "vitest";
import type { VoiceTurn } from "@/features/voice/voice-store";

vi.mock("@/lib/gateway", () => ({ gateway: vi.fn() }));
vi.mock("@/lib/platform", () => ({ isTauri: () => true }));
vi.mock("@/stores/settings", () => ({
  isDesktopApp: () => true,
  isAndroidApp: () => false, useSettings: Object.assign(() => "", { getState: () => ({}) }) }));
vi.mock("./os-store", () => ({ useOs: { getState: () => ({ load: async () => undefined }) } }));
vi.mock("./pipeline-store", () => ({ startPipelineFeed: vi.fn() }));

import { mirrorThreads, syncKey } from "./thread-sync";

const t = (o: Partial<VoiceTurn>): VoiceTurn => ({ id: "a", who: "agent", text: "x", thread: "auto", at: 1, ...o });

describe("desktop → phone thread mirror (regressions)", () => {
  it("an in-place update (a streamed answer finishing) changes the push key", () => {
    // The key was count + last id: the streamed bubble's final text was never pushed.
    const partial = [t({ id: "u", who: "user" }), t({ id: "live", meta: "streaming…", text: "Once" })];
    const full = [partial[0], { ...partial[1], text: "Once upon a time.", meta: "local", rev: 3 }];
    expect(syncKey(full)).not.toBe(syncKey(partial));
    expect(syncKey(partial)).toBe(syncKey([...partial]));
  });
  it("system lines are mirrored too (approvals, cancels, verifier verdicts, build alerts)", () => {
    const m = mirrorThreads([t({ id: "1", who: "system", text: "Approved (tap): Stage “Tip”" }), t({ id: "2" }), t({ id: "3", thread: "coder" })]);
    expect(m.auto.map((x) => x.id)).toEqual(["1", "2"]);
    expect(m.coder).toHaveLength(1);
    const many = mirrorThreads(Array.from({ length: 90 }, (_, i) => t({ id: `n${i}` })));
    expect(many.auto).toHaveLength(60);
    expect(many.auto[59].id).toBe("n89");
  });
});
