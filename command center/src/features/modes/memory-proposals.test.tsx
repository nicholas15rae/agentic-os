import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Decision 5: the memory card under a Learning reply. The desktop app's Save / Skip call the Tauri
 * commands; every phone (the PWA, and the Android app, which is Tauri too) queues `memoryApprove` /
 * `memoryDiscard` for the desktop; an answered proposal leaves the card and what was saved becomes
 * a "Memory saved" pill. Platform and gateway are stubbed: `tauri` is the Tauri global,
 * `desktop` is settings' `isDesktopApp()` (false on Android).
 */
vi.hoisted(() => {
  const m = new Map<string, string>(); // the voice store persists (no browser storage under node)
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 },
  });
});
const h = vi.hoisted(() => ({ tauri: true, desktop: true, native: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/platform", () => ({ isTauri: () => h.tauri, native: h.native }));
vi.mock("@/stores/settings", () => ({ isDesktopApp: () => h.desktop, isAndroidApp: () => h.tauri && !h.desktop }));
vi.mock("@/features/dispatcher/dispatch", () => ({ sendMemoryDecision: h.send }));

import { CARD_END_LABEL, MemoryProposalCard } from "./MemoryProposalCard";
import { afterDecision, decideMemory, MEMORY_GONE, MEMORY_NO_DESKTOP, resetRestartCheckForTests, settleCardsAfterRestart } from "./memory-proposals";
import { CORE_QUESTION, DISCARDED_REPLY, PROPOSAL_TTL_MS, SAVED_REPLY, SAVE_FAILED_REPLY, type LearnedPathway, type MemoryCardEnd, type PendingMemory } from "./learning";
import { useVoice } from "@/features/voice/voice-store";

const p1: PendingMemory = { id: "mem-1-2", category: "domain_knowledge", text: "When someone asks who books Nic: the Booking Desk handles it" };
const p2: PendingMemory = { id: "mem-1-3", category: "persona", text: "Call me Nic" };
const saved: LearnedPathway = { id: "lp-9-0", title: "the Booking Desk handles it", category: "domain_knowledge", confidence: "confirmed", outcome: "saved" };

beforeEach(() => {
  h.tauri = true;
  h.desktop = true;
  h.native.mockReset();
  h.send.mockReset();
});

describe("decideMemory", () => {
  it("desktop: Save calls learning_approve and returns what was saved; Skip calls learning_discard", async () => {
    h.native.mockResolvedValueOnce([saved]);
    expect(await decideMemory(p1.id, true)).toEqual([saved]);
    expect(h.native).toHaveBeenCalledWith("learning_approve", { id: p1.id });
    h.native.mockResolvedValueOnce(true);
    expect(await decideMemory(p1.id, false)).toEqual([]);
    expect(h.native).toHaveBeenLastCalledWith("learning_discard", { id: p1.id });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("desktop: an expired proposal is Rust's error, surfaced", async () => {
    h.native.mockRejectedValueOnce(new Error("that memory proposal expired or was already answered"));
    await expect(decideMemory(p1.id, true)).rejects.toThrow("expired");
  });

  it("desktop: a Skip Rust no longer holds is an error, never a silent skip", async () => {
    h.native.mockResolvedValueOnce(false);
    await expect(decideMemory(p1.id, false)).rejects.toThrow(MEMORY_GONE);
  });

  it("Android app (Tauri, not the desktop): the inbox command, never the phone's own Rust", async () => {
    h.desktop = false;
    h.send.mockResolvedValueOnce({ id: p1.id, approved: true, saved: [saved] });
    expect(await decideMemory(p1.id, true)).toEqual([saved]);
    expect(h.send).toHaveBeenLastCalledWith(p1.id, true);
    h.send.mockResolvedValueOnce({ id: p1.id, approved: false, saved: [] });
    expect(await decideMemory(p1.id, false)).toEqual([]);
    expect(h.send).toHaveBeenLastCalledWith(p1.id, false);
    // The desktop's refusal (expired / already answered) is surfaced, so the row stays.
    h.send.mockRejectedValueOnce(new Error("that memory proposal expired or was already answered"));
    await expect(decideMemory(p1.id, false)).rejects.toThrow("expired");
    expect(h.native).not.toHaveBeenCalled();
  });

  it("phone (PWA): the inbox command; no desktop answer is an error, never a silent save", async () => {
    h.tauri = false;
    h.desktop = false;
    h.send.mockResolvedValueOnce({ id: p1.id, approved: true, saved: [saved, { bad: 1 }] });
    expect(await decideMemory(p1.id, true)).toEqual([saved]);
    expect(h.send).toHaveBeenCalledWith(p1.id, true);
    h.send.mockResolvedValueOnce({ id: p1.id, approved: false, saved: [] });
    expect(await decideMemory(p1.id, false)).toEqual([]);
    h.send.mockResolvedValueOnce(null);
    await expect(decideMemory(p1.id, true)).rejects.toThrow(MEMORY_NO_DESKTOP);
    expect(h.native).not.toHaveBeenCalled();
  });

  it("refuses a malformed id before any call", async () => {
    await expect(decideMemory("../x", true)).rejects.toThrow("bad memory proposal id");
    expect(h.native).not.toHaveBeenCalled();
  });
});

describe("afterDecision", () => {
  it("the answered row leaves the card; a save becomes a pill; the last one empties the card", () => {
    const a = afterDecision({ pendingMemory: [p1, p2] }, p1.id, [saved]);
    expect(a).toEqual({ pendingMemory: [p2], learned: [saved] });
    const b = afterDecision(a, p2.id, []);
    expect(b).toEqual({ pendingMemory: undefined, learned: [saved] });
    // The same save twice is one pill.
    expect(afterDecision({ pendingMemory: [p1], learned: [saved] }, p1.id, [saved]).learned).toEqual([saved]);
  });
});

describe("MemoryProposalCard", () => {
  it("shows each proposal with Save and Skip, and nothing when there are none", () => {
    const html = renderToStaticMarkup(<MemoryProposalCard turnId="t1" items={[p1, p2]} />);
    expect(html).toContain('aria-label="Core memory proposal"');
    expect(html).toContain("needs your yes");
    expect(html).toContain(p1.text);
    expect(html).toContain("domain knowledge");
    expect(html.match(/> Save</g)?.length).toBe(2);
    expect(html.match(/> Skip</g)?.length).toBe(2);
    expect(renderToStaticMarkup(<MemoryProposalCard turnId="t1" items={[]} />)).toBe("");
  });

  it("an answered, expired or restarted card shows what became of it, never live buttons (FX2)", () => {
    for (const [end, label] of Object.entries(CARD_END_LABEL) as [MemoryCardEnd, string][]) {
      const html = renderToStaticMarkup(<MemoryProposalCard turnId="t1" items={[p1, p2]} end={end} expiresAt={Date.now() + 60_000} />);
      expect(html).toContain(label);
      expect(html).toContain(p1.text); // the rows stay, as the record
      expect(html).not.toContain("needs your yes");
      expect(html).not.toMatch(/> (Save|Skip)</);
    }
    expect(CARD_END_LABEL.gone).toBe("No longer pending");
    // Past its expiry (Rust's 10-minute TTL) with no answer: no longer pending.
    const expired = renderToStaticMarkup(<MemoryProposalCard turnId="t1" items={[p1]} expiresAt={Date.now() - 1} />);
    expect(expired).toContain("No longer pending");
    expect(expired).not.toMatch(/> (Save|Skip)</);
    // Still within it: live.
    const live = renderToStaticMarkup(<MemoryProposalCard turnId="t1" items={[p1]} expiresAt={Date.now() + 1_000} />);
    expect(live).toContain("needs your yes");
    expect(live.match(/> Save</g)?.length).toBe(1);
  });
});

describe("the store ends a card its proposals no longer back (FX2)", () => {
  const T0 = 1_764_000_000_000;
  const card: PendingMemory[] = [{ id: `mem-${T0}-5`, category: "domain_knowledge", text: p1.text }];
  const ASK = `So the Booking Desk handles it? ${CORE_QUESTION}`;

  beforeEach(() => {
    useVoice.setState({ turns: [] });
    resetRestartCheckForTests();
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 800);
  });
  afterEach(() => vi.useRealTimers());

  it("a card gets its expiry (created + 10 min) when it arrives, by pushTurn or a streamed turn's update", () => {
    const v = useVoice.getState();
    const pushed = v.pushTurn({ who: "agent", text: ASK, thread: "auto", from: "os", pendingMemory: card });
    expect(pushed.memoryExpiresAt).toBe(T0 + PROPOSAL_TTL_MS);
    const live = v.pushTurn({ who: "agent", text: "So the…", thread: "auto", meta: "streaming…" });
    expect(live.memoryExpiresAt).toBeUndefined();
    v.updateTurn(live.id, { text: ASK, meta: "lmstudio · 900ms", pendingMemory: [{ ...card[0], id: "mem-1-2" }] });
    expect(useVoice.getState().turns.find((t) => t.id === live.id)?.memoryExpiresAt).toBe(T0 + 800 + PROPOSAL_TTL_MS);
  });

  it("Rust's answer to a typed / spoken yes ends the card above it as Saved (pushed whole, or streamed then finished)", () => {
    const v = useVoice.getState();
    const proposal = v.pushTurn({ who: "agent", text: ASK, thread: "auto", from: "os", pendingMemory: card });
    v.pushTurn({ who: "user", text: "yes", thread: "auto" });
    // Desktop osRun: the one-chunk stream first (no answer meta yet), then the final result.
    const live = v.pushTurn({ who: "agent", text: SAVED_REPLY, thread: "auto", from: "os", meta: "streaming…" });
    expect(useVoice.getState().turns.find((t) => t.id === proposal.id)?.memoryEnd).toBeUndefined();
    v.updateTurn(live.id, { text: SAVED_REPLY, meta: "learning · 4ms", learned: [saved] });
    const after = useVoice.getState().turns.find((t) => t.id === proposal.id)!;
    expect(after).toMatchObject({ memoryEnd: "saved", pendingMemory: card });
    expect(after.rev).toBe(1);
    // A no, on the phone (pushed whole): Skipped.
    useVoice.setState({ turns: [] });
    const p2nd = v.pushTurn({ who: "agent", text: ASK, thread: "general", from: "os", pendingMemory: card });
    v.pushTurn({ who: "user", text: "no", thread: "general" });
    v.pushTurn({ who: "agent", text: DISCARDED_REPLY, thread: "general", from: "os", meta: "Tony · desktop:learning · 700ms" });
    expect(useVoice.getState().turns.find((t) => t.id === p2nd.id)?.memoryEnd).toBe("skipped");
  });

  it("a normal reply (even one that says the words) leaves the card live", () => {
    const v = useVoice.getState();
    const proposal = v.pushTurn({ who: "agent", text: ASK, thread: "auto", from: "os", pendingMemory: card });
    v.pushTurn({ who: "user", text: "yes, but only on weekdays", thread: "auto" });
    v.pushTurn({ who: "agent", text: SAVED_REPLY, thread: "auto", from: "os", meta: "lmstudio · 900ms" });
    expect(useVoice.getState().turns.find((t) => t.id === proposal.id)?.memoryEnd).toBeUndefined();
  });

  it("a yes after Rust's failed save (streamed, then finished) ends the card as Saved", () => {
    const v = useVoice.getState();
    const proposal = v.pushTurn({ who: "agent", text: ASK, thread: "auto", from: "os", pendingMemory: card });
    v.pushTurn({ who: "user", text: "yes", thread: "auto" });
    v.pushTurn({ who: "agent", text: SAVE_FAILED_REPLY, thread: "auto", from: "os", meta: "learning · 3ms" });
    expect(useVoice.getState().turns.find((t) => t.id === proposal.id)?.memoryEnd).toBeUndefined();
    v.pushTurn({ who: "user", text: "yes", thread: "auto" });
    const live = v.pushTurn({ who: "agent", text: SAVED_REPLY, thread: "auto", from: "os", meta: "streaming…" });
    v.updateTurn(live.id, { text: SAVED_REPLY, meta: "learning · 4ms", learned: [saved] });
    expect(useVoice.getState().turns.find((t) => t.id === proposal.id)?.memoryEnd).toBe("saved");
  });

  it("the desktop's two Tony threads: a newer card in 'general' keeps the yes in 'auto' from ending the older card", () => {
    const v = useVoice.getState();
    const a = v.pushTurn({ who: "agent", text: ASK, thread: "auto", from: "os", pendingMemory: card });
    const b = v.pushTurn({ who: "agent", text: ASK, thread: "general", from: "os", pendingMemory: [{ ...card[0], id: `mem-${T0 + 500}-8` }] });
    v.pushTurn({ who: "user", text: "yes", thread: "auto" });
    v.pushTurn({ who: "agent", text: SAVED_REPLY, thread: "auto", from: "os", meta: "learning · 4ms" });
    const byId = (id: string) => useVoice.getState().turns.find((t) => t.id === id);
    expect(byId(a.id)?.memoryEnd).toBeUndefined();
    expect(byId(b.id)?.memoryEnd).toBeUndefined();
  });

  it("desktop app: once per load, cards proposed before this run of the app are No longer pending", async () => {
    const v = useVoice.getState();
    const before = v.pushTurn({ who: "agent", text: ASK, thread: "auto", pendingMemory: card });
    vi.setSystemTime(T0 + 120_000);
    const after = v.pushTurn({ who: "agent", text: ASK, thread: "auto", pendingMemory: [{ ...card[0], id: `mem-${T0 + 119_000}-6` }] });
    h.native.mockResolvedValueOnce({ startedAt: T0 + 60_000, uptimeSecs: 60 });
    await settleCardsAfterRestart();
    expect(h.native).toHaveBeenCalledWith("app_uptime");
    const byId = (id: string) => useVoice.getState().turns.find((t) => t.id === id);
    expect(byId(before.id)?.memoryEnd).toBe("gone");
    expect(byId(after.id)?.memoryEnd).toBeUndefined(); // proposed in this run: live
    await settleCardsAfterRestart();
    expect(h.native).toHaveBeenCalledTimes(1); // once per load
  });

  it("a Hard Reload (webview only, Rust kept running) keeps cards live; the phone never asks; a failed ask is retried", async () => {
    const v = useVoice.getState();
    const t = v.pushTurn({ who: "agent", text: ASK, thread: "auto", pendingMemory: card });
    h.native.mockRejectedValueOnce(new Error("ipc down"));
    await settleCardsAfterRestart();
    h.native.mockResolvedValueOnce({ startedAt: T0 - 3_600_000, uptimeSecs: 3600 });
    await settleCardsAfterRestart();
    expect(h.native).toHaveBeenCalledTimes(2);
    expect(useVoice.getState().turns.find((x) => x.id === t.id)?.memoryEnd).toBeUndefined();
    resetRestartCheckForTests();
    h.desktop = false;
    await settleCardsAfterRestart();
    expect(h.native).toHaveBeenCalledTimes(2);
  });
});
