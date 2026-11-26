import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Decision 5: the memory card under a Learning reply. The desktop app's Save / Skip call the Tauri
 * commands; every phone (the PWA, and the Android app, which is Tauri too) queues `memoryApprove` /
 * `memoryDiscard` for the desktop; an answered proposal leaves the card and what was saved becomes
 * a "Memory saved" pill. Platform and gateway are stubbed: `tauri` is the Tauri global,
 * `desktop` is settings' `isDesktopApp()` (false on Android).
 */
const h = vi.hoisted(() => ({ tauri: true, desktop: true, native: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/platform", () => ({ isTauri: () => h.tauri, native: h.native }));
vi.mock("@/stores/settings", () => ({ isDesktopApp: () => h.desktop, isAndroidApp: () => h.tauri && !h.desktop }));
vi.mock("@/features/dispatcher/dispatch", () => ({ sendMemoryDecision: h.send }));

import { MemoryProposalCard } from "./MemoryProposalCard";
import { afterDecision, decideMemory, MEMORY_GONE, MEMORY_NO_DESKTOP } from "./memory-proposals";
import type { LearnedPathway, PendingMemory } from "./learning";

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
});
