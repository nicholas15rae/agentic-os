import { describe, expect, it } from "vitest";
import type { CancelReason, WrapItem, WrapUp } from "./session-types";
import * as H from "./wrapup";
import { applyCancel, markFailed, markSending, markSent, needsDestination, setDestination, statusAfterCancel, walkQueue, walkReply, walkStep, wrapCounts } from "./wrapup";
import * as T from "./talk-intent";
import * as G from "./talk-digest";
import * as D from "./destinations";

const item = (id: string, o: Partial<WrapItem> = {}): WrapItem => ({
  id, kind: "idea", text: `text ${id}`, quote: `quote ${id}`, speaker: "nic", t: 1, suggested: "ledger", dest: "ledger", status: "pending", ...o,
});
const wrap = (items: WrapItem[]): WrapUp => ({ at: 1, title: "T", summary: "S", items, engine: "llm", coveredSegments: 3, dropped: 0 });
const ok = (r: ReturnType<typeof applyCancel>) => {
  if (!r.ok) throw new Error(r.error);
  return r.wrapup;
};

describe("only an explicit 'declined' skips an item", () => {
  const others: CancelReason[] = ["timed out", "superseded", "dismissed", "cut", "stopped"];
  it("statusAfterCancel", () => {
    expect(statusAfterCancel("declined")).toBe("skipped");
    for (const r of others) expect(statusAfterCancel(r), r).toBe("pending");
  });
  it("applyCancel changes only the one item, and only on declined", () => {
    const w = wrap([item("a"), item("b"), item("c")]);
    const d = ok(applyCancel(w, "b", "declined"));
    expect(d.items.map((i) => i.status)).toEqual(["pending", "skipped", "pending"]);
    expect(w.items[1].status).toBe("pending"); // input untouched
    for (const r of others) expect(ok(applyCancel(w, "b", r)).items.map((i) => i.status), r).toEqual(["pending", "pending", "pending"]);
  });
  it("a decided item is never cancelled again", () => {
    const w = wrap([item("a", { status: "sent" })]);
    expect(applyCancel(w, "a", "declined")).toEqual({ ok: false, error: "bad_status" });
    expect(applyCancel(w, "zz", "declined")).toEqual({ ok: false, error: "no_item" });
  });
});

describe("one item at a time: send lifecycle", () => {
  it("pending → sending → sent, touching no other item", () => {
    const w = wrap([item("a"), item("b")]);
    const s = ok(markSending(w, "a"));
    expect(s.items.map((i) => i.status)).toEqual(["sending", "pending"]);
    const done = ok(markSent(s, "a", { dest: "ledger", refId: "idea1", at: 5, via: "voice" }));
    expect(done.items[0]).toMatchObject({ status: "sent", sentTo: { dest: "ledger", refId: "idea1", at: 5, via: "voice" } });
    expect(done.items[1].status).toBe("pending");
  });
  it("failed can be retried; the error clears on retry", () => {
    const w = ok(markFailed(ok(markSending(wrap([item("a")]), "a")), "a", "offline"));
    expect(w.items[0]).toMatchObject({ status: "failed", error: "offline" });
    const r = ok(markSending(w, "a"));
    expect(r.items[0].status).toBe("sending");
    expect(r.items[0].error).toBeUndefined();
  });
  it("refuses a send without an allowed destination", () => {
    expect(markSending(wrap([item("a", { dest: null })]), "a")).toEqual({ ok: false, error: "bad_dest" });
    expect(markSending(wrap([item("a", { dest: "memory", speaker: "tony" })]), "a")).toEqual({ ok: false, error: "bad_dest" });
    expect(markSending(wrap([item("a", { status: "skipped" })]), "a")).toEqual({ ok: false, error: "bad_status" });
    expect(markSent(wrap([item("a")]), "a", { dest: "ledger", refId: "x", at: 1, via: "tap" })).toEqual({ ok: false, error: "bad_status" });
    const sending = ok(markSending(wrap([item("a")]), "a"));
    expect(markSent(sending, "a", { dest: "play_place", refId: "x", at: 1, via: "tap" })).toEqual({ ok: false, error: "bad_dest" });
  });
  it("setDestination: by tap, pending or failed only, memory only for Nic", () => {
    const w = wrap([item("a", { dest: null }), item("b", { speaker: "tony" }), item("c", { status: "sent" })]);
    expect(ok(setDestination(w, "a", "director")).items[0].dest).toBe("director");
    expect(setDestination(w, "b", "memory")).toEqual({ ok: false, error: "bad_dest" });
    expect(setDestination(w, "c", "ledger")).toEqual({ ok: false, error: "bad_status" });
  });
});

describe("voice walk", () => {
  it("queues pending items with a destination, in order; others need a tap", () => {
    const w = wrap([item("a"), item("b", { dest: null }), item("c", { status: "skipped" }), item("d", { dest: "memory" })]);
    expect(walkQueue(w).map((i) => i.id)).toEqual(["a", "d"]);
    expect(needsDestination(w).map((i) => i.id)).toEqual(["b"]);
  });
  it("reads yes / no / stop / unclear", () => {
    for (const s of ["yes", "Yeah.", "send it", "ok send it", "go ahead", "yes please"]) expect(walkReply(s), s).toBe("yes");
    for (const s of ["no", "Nope.", "skip it", "no thanks", "not that one", "pass"]) expect(walkReply(s), s).toBe("no");
    for (const s of ["stop", "Stop.", "that's enough", "no, stop", "we're done", "cut it", "end"]) expect(walkReply(s), s).toBe("stop");
    for (const s of ["", "hmm", "yes but to Director", "send it somewhere else", "approve all", "yes to all of them"]) expect(walkReply(s), s).toBe("unclear");
  });
  it("reads curly apostrophes like straight ones", () => {
    for (const s of ["that’s enough", "we’re done", "I’m done", "No, that’s enough."]) expect(walkReply(s), s).toBe("stop");
    for (const s of ["don’t", "don't"]) expect(walkReply(s), s).toBe("no");
  });
  it("a bare ok / okay is filler, not a yes", () => {
    for (const s of ["ok", "okay", "Okay.", "OK"]) expect(walkReply(s), s).toBe("unclear");
    for (const s of ["ok send it", "okay, do it", "ok yes"]) expect(walkReply(s), s).toBe("yes");
  });
  it("each reply acts on the one card's item only", () => {
    const i = item("a");
    expect(walkStep(i, "yes")).toEqual({ action: "approve", itemId: "a", dest: "ledger" });
    expect(walkStep(i, "no")).toEqual({ action: "cancel", itemId: "a", reason: "declined", endWalk: false });
    expect(walkStep(i, "stop")).toEqual({ action: "cancel", itemId: "a", reason: "stopped", endWalk: true });
    expect(walkStep(i, "unclear")).toEqual({ action: "ask_again", itemId: "a" });
    expect(walkStep(item("b", { dest: null }), "yes")).toEqual({ action: "ask_again", itemId: "b" });
  });
  it("stop leaves the rest pending", () => {
    const w = wrap([item("a"), item("b"), item("c")]);
    const step = walkStep(w.items[0], walkReply("stop"));
    if (step.action !== "cancel") throw new Error("expected cancel");
    expect(ok(applyCancel(w, step.itemId, step.reason)).items.every((x) => x.status === "pending")).toBe(true);
  });
  it("counts", () => {
    expect(wrapCounts(wrap([item("a"), item("b", { status: "sent" }), item("c", { status: "skipped" })]))).toEqual({ pending: 1, sending: 0, sent: 1, skipped: 1, failed: 0 });
  });
});

describe("no bulk approve exists anywhere in the helpers", () => {
  it("no export is named like one", () => {
    for (const mod of [H, T, G, D]) expect(Object.keys(mod).filter((k) => /all|bulk|batch|every|many/i.test(k))).toEqual([]);
  });
  it("every status change takes exactly one item id", () => {
    const w = wrap([item("a"), item("b")]);
    for (const r of [markSending(w, "a"), applyCancel(w, "a", "declined"), setDestination(w, "a", "director")]) {
      const after = ok(r);
      expect(after.items[1]).toEqual(w.items[1]);
    }
    // A list of ids is not an id: nothing matches it.
    expect(markSending(w, ["a", "b"] as unknown as string)).toEqual({ ok: false, error: "no_item" });
  });
});
