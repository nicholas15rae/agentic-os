import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ALREADY_REPLY,
  CORE_QUESTION,
  DISCARDED_REPLY,
  PROPOSAL_TTL_MS,
  SAVED_REPLY,
  SAVE_FAILED_REPLY,
  answeredMemoryOf,
  answeringIds,
  cardExpiresAt,
  endCardsBefore,
  learnedOf,
  learnedPillText,
  memoryAnswerOf,
  pendingMemoryOf,
  pillPathways,
  proposalCreatedAt,
  settleAnsweredCard,
  stripLearnTags,
  withCardExpiry,
  type CardTurn,
  type PendingMemory,
} from "./learning";

describe("stripLearnTags", () => {
  it("removes complete tags and collapses the gap they leave", () => {
    expect(stripLearnTags("Got it.\n\n[[LEARN rule | x | y | confirmed]]\n\nStored.", true)).toBe("Got it.\n\nStored.");
    expect(stripLearnTags("ok [[learn: pref | a | b]] done", true)).toBe("ok  done");
  });

  it("holds back a tag that is still streaming, and nothing else", () => {
    expect(stripLearnTags("So when X, you want Y?\n[[LEA")).toBe("So when X, you want Y?\n");
    expect(stripLearnTags("Saved.\n[[LEARN rule | when deploying | run plan")).toBe("Saved.\n");
    expect(stripLearnTags("Saved. [")).toBe("Saved. ");
    expect(stripLearnTags("see [[wiki link")).toBe("see [[wiki link");
    expect(stripLearnTags("Saved. [", true)).toBe("Saved. [");
  });

  it("keeps the text before a tag stable while it streams in", () => {
    const full = "Locked in. [[LEARN rule | a | b | confirmed]] Anything else?";
    const before = "Locked in. ";
    for (let i = before.length; i <= full.length; i++) expect(stripLearnTags(full.slice(0, i)).startsWith(before)).toBe(true);
    expect(stripLearnTags(full)).toBe("Locked in.  Anything else?");
  });
});

describe("pills", () => {
  it("names what happened and skips already-known lessons", () => {
    const l = [
      { id: "1", title: "Use kebab-case", category: "rule", confidence: "confirmed", outcome: "saved" },
      { id: "2", title: "Ask indoor or patio", category: "preference", confidence: "provisional", outcome: "superseded" },
      { id: "3", title: "Old", category: "rule", confidence: "confirmed", outcome: "unchanged" },
    ];
    expect(pillPathways(l).map(learnedPillText)).toEqual(["Memory saved: Use kebab-case", "Memory updated: Ask indoor or patio (provisional)"]);
    expect(pillPathways(undefined)).toEqual([]);
  });

  it("a replaced core memory is named, and a Save that changed nothing never reads as a save", () => {
    const base = { id: "lp-1", title: "Send the report every Monday", category: "correction", confidence: "confirmed" };
    expect(learnedPillText({ ...base, outcome: "superseded", replaced: "When weekly report: send it every Friday" })).toBe("Memory updated: Send the report every Monday (replaced: When weekly report: send it every Friday)");
    expect(learnedPillText({ ...base, outcome: "unchanged" })).toBe("Already a core memory: Send the report every Monday");
    // learnedOf keeps `replaced` (a string) and drops anything else there.
    expect(learnedOf([{ ...base, outcome: "superseded", replaced: "old" }, { ...base, outcome: "saved", replaced: 3 }])).toEqual([
      { ...base, outcome: "superseded", replaced: "old" },
      { ...base, outcome: "saved" },
    ]);
  });
});

describe("core memory proposals (decision 5)", () => {
  const rs = readFileSync(resolve(__dirname, "../../../src-tauri/src/commands/learning.rs"), "utf8");

  it("CORE_QUESTION is the Rust constant, and the Learning protocol asks it", () => {
    expect(rs).toContain(`pub const CORE_QUESTION: &str = "${CORE_QUESTION}";`);
  });

  it("pendingMemoryOf keeps only well-formed rows with a valid id", () => {
    expect(pendingMemoryOf([{ id: "mem-1-2", category: "rule", text: "Call me Nic", extra: 1 }, { id: "a b", category: "rule", text: "x" }, { id: "m", category: "rule", text: "  " }, null, "x"])).toEqual([{ id: "mem-1-2", category: "rule", text: "Call me Nic" }]);
    expect(pendingMemoryOf(undefined)).toEqual([]);
    expect(pendingMemoryOf({ id: "mem-1" })).toEqual([]);
  });

  it("learnedOf keeps only well-formed rows", () => {
    const ok = { id: "lp-1", title: "Call me Nic", category: "persona", confidence: "confirmed", outcome: "saved" };
    expect(learnedOf([ok, { ...ok, title: 3 }, null])).toEqual([ok]);
    expect(learnedOf("nope")).toEqual([]);
  });
});

describe("memory cards never outlive their proposals (FX2)", () => {
  const rs = readFileSync(resolve(__dirname, "../../../src-tauri/src/commands/learning.rs"), "utf8");
  const agents = readFileSync(resolve(__dirname, "../../../src-tauri/src/commands/agents.rs"), "utf8");
  const T0 = 1_764_000_000_000; // a Rust ms timestamp, as proposal ids carry it
  const card: PendingMemory[] = [{ id: `mem-${T0}-7`, category: "domain_knowledge", text: "When someone asks who books Nic: the Booking Desk handles it" }];
  const turn = (id: string, who: string, text: string, extra: Partial<CardTurn> = {}): CardTurn => ({ id, who, thread: "auto", text, at: T0, ...extra });

  it("mirrors Rust: the TTL, the fixed replies, the id's timestamp and the answer's provider id", () => {
    expect(rs).toContain("pub const PROPOSAL_TTL_MS: u64 = 10 * 60 * 1000;");
    expect(PROPOSAL_TTL_MS).toBe(600_000);
    expect(rs).toContain(`pub const SAVED_REPLY: &str = "${SAVED_REPLY}";`);
    expect(rs).toContain(`pub const ALREADY_REPLY: &str = "${ALREADY_REPLY}";`);
    expect(rs).toContain(`pub const DISCARDED_REPLY: &str = "${DISCARDED_REPLY}";`);
    expect(rs).toContain(`pub const SAVE_FAILED_REPLY: &str = "${SAVE_FAILED_REPLY}";`);
    expect(rs).toContain('format!("mem-{now}-{}", next_seq())');
    // `answer_proposal`'s result carries provider "learning" (memoryAnswerOf reads it from the meta).
    expect(agents).toContain('provider_id: "learning".into()');
  });

  it("memoryAnswerOf: only Rust's own answer turn (provider 'learning', desktop or phone), never the model saying the same words", () => {
    expect(memoryAnswerOf({ who: "agent", text: SAVED_REPLY, meta: "learning · 4ms" })).toBe("saved");
    expect(memoryAnswerOf({ who: "agent", text: `${SAVED_REPLY} That replaces the old one: "x".`, meta: "Tony · desktop:learning · 900ms" })).toBe("saved");
    expect(memoryAnswerOf({ who: "agent", text: ALREADY_REPLY, meta: "learning · 2ms" })).toBe("known");
    expect(memoryAnswerOf({ who: "agent", text: DISCARDED_REPLY, meta: "Tony · desktop:learning · 5ms" })).toBe("skipped");
    // A save that failed leaves the proposals pending (same ids): the card stays live.
    expect(memoryAnswerOf({ who: "agent", text: SAVE_FAILED_REPLY, meta: "learning · 3ms" })).toBeNull();
    expect(memoryAnswerOf({ who: "agent", text: SAVE_FAILED_REPLY, meta: "Tony · desktop:learning · 900ms" })).toBeNull();
    // The model (any other provider) saying it is no answer; nor is the user's own line.
    expect(memoryAnswerOf({ who: "agent", text: SAVED_REPLY, meta: "lmstudio · 812ms" })).toBeNull();
    expect(memoryAnswerOf({ who: "agent", text: DISCARDED_REPLY, meta: "Tony · desktop:lmstudio · 5ms" })).toBeNull();
    expect(memoryAnswerOf({ who: "agent", text: SAVED_REPLY, meta: "machine-learning · 4ms" })).toBeNull();
    expect(memoryAnswerOf({ who: "agent", text: SAVED_REPLY })).toBeNull();
    expect(memoryAnswerOf({ who: "user", text: DISCARDED_REPLY, meta: "learning · 1ms" })).toBeNull();
  });

  it("the expiry is the proposal's created time + 10 min: Rust's id timestamp when plausible, else when the card arrived", () => {
    expect(proposalCreatedAt(card, T0 + 1_200)).toBe(T0);
    expect(withCardExpiry(turn("a1", "agent", CORE_QUESTION, { pendingMemory: card }), T0 + 1_200).memoryExpiresAt).toBe(T0 + PROPOSAL_TTL_MS);
    // An id from the other device's future (its clock is ahead), garbage, or test ids: the arrival time.
    expect(proposalCreatedAt(card, T0 - 2_000)).toBe(T0 - 2_000);
    expect(proposalCreatedAt([{ ...card[0], id: "mem-1-2" }], T0)).toBe(T0);
    expect(proposalCreatedAt(card, T0 + 2 * 86_400_000)).toBe(T0 + 2 * 86_400_000);
    // Stamped once; a turn without a card is untouched.
    const stamped = withCardExpiry({ pendingMemory: card, memoryExpiresAt: 42 }, T0);
    expect(stamped.memoryExpiresAt).toBe(42);
    const plain = turn("a2", "agent", "hi");
    expect(withCardExpiry(plain, T0)).toBe(plain);
    // A card saved before the expiry was stored: from its ids, else the turn's time.
    expect(cardExpiresAt({ pendingMemory: card, at: T0 + 500 })).toBe(T0 + PROPOSAL_TTL_MS);
    expect(cardExpiresAt({ pendingMemory: [{ ...card[0], id: "mem-1-2" }], at: T0 + 500 })).toBe(T0 + 500 + PROPOSAL_TTL_MS);
    expect(cardExpiresAt({ pendingMemory: card, memoryExpiresAt: 7, at: T0 })).toBe(7);
  });

  it("settleAnsweredCard: the answer ends the card on Tony's immediately preceding reply in that thread", () => {
    const proposal = turn("a1", "agent", `So the Booking Desk handles it? ${CORE_QUESTION}`, { pendingMemory: card, rev: 2 });
    const yes = turn("u1", "user", "yes");
    const saved = turn("a2", "agent", SAVED_REPLY, { meta: "learning · 4ms" });
    // An older card in another thread, and a later agent turn elsewhere that proposed nothing (a build's output).
    const other = turn("x1", "agent", "Elsewhere.", { thread: "general", pendingMemory: [{ ...card[0], id: "mem-2-1" }] });
    const chat = turn("x2", "agent", "Build finished.", { thread: "coder" });
    const note = turn("s1", "system", "Mode: Learning");
    const out = settleAnsweredCard([other, proposal, chat, yes, note, saved], "a2");
    expect(out[1]).toMatchObject({ id: "a1", memoryEnd: "saved", rev: 3, pendingMemory: card });
    expect(out[0]).toBe(other); // another thread's card is never touched
    for (const [text, end] of [[DISCARDED_REPLY, "skipped"], [ALREADY_REPLY, "known"]] as const) {
      expect(settleAnsweredCard([proposal, yes, { ...saved, text }], "a2")[0].memoryEnd).toBe(end);
    }
  });

  it("settleAnsweredCard leaves everything else alone", () => {
    const proposal = turn("a1", "agent", CORE_QUESTION, { pendingMemory: card });
    const yes = turn("u1", "user", "yes");
    const answer = turn("a3", "agent", SAVED_REPLY, { meta: "learning · 4ms" });
    // Not an answer turn (the model's own words, or the failed save).
    const list = [proposal, yes, { ...answer, meta: "lmstudio · 9ms" }];
    expect(settleAnsweredCard(list, "a3")).toBe(list);
    // Tony's last reply in between had no card (the batch it answered is not this one): nothing changes.
    const between = [proposal, turn("a2", "agent", "Is that every weekday?"), yes, answer];
    expect(settleAnsweredCard(between, "a3")).toBe(between);
    // An ended card stays as it ended; an unknown id changes nothing.
    const ended = [{ ...proposal, memoryEnd: "gone" as const }, yes, answer];
    expect(settleAnsweredCard(ended, "a3")).toBe(ended);
    expect(settleAnsweredCard(ended, "nope")).toBe(ended);
  });

  it("a yes / no that retries after Rust's failed save ends the card (Rust kept the batch and asked again)", () => {
    // Rust's own reply text (learning.rs), as the reviewer reproduced it.
    expect(SAVE_FAILED_REPLY).toBe("I couldn't save that just now. Want me to try again and add it to my core memories?");
    const proposal = turn("a1", "agent", `Got it. ${CORE_QUESTION}`, { pendingMemory: card, memoryExpiresAt: T0 + PROPOSAL_TTL_MS });
    const failed = (id: string, meta = "learning · 3ms") => turn(id, "agent", SAVE_FAILED_REPLY, { meta });
    const yes = (id: string) => turn(id, "user", "yes");
    for (const [text, end] of [[SAVED_REPLY, "saved"], [DISCARDED_REPLY, "skipped"], [ALREADY_REPLY, "known"]] as const) {
      const list = [proposal, yes("u1"), failed("f1"), yes("u2"), turn("a2", "agent", text, { meta: "learning · 4ms" })];
      expect(memoryAnswerOf(list[2])).toBeNull(); // the failed save itself never ends the card
      expect(settleAnsweredCard(list, "f1")).toBe(list);
      expect(settleAnsweredCard(list, "a2")[0].memoryEnd).toBe(end);
    }
    // Two failed saves in a row, on the phone (its meta), then a yes that saves.
    const phone = [proposal, yes("u1"), failed("f1", "Tony · desktop:learning · 9ms"), yes("u2"), failed("f2", "Tony · desktop:learning · 8ms"), yes("u3"), turn("a2", "agent", SAVED_REPLY, { meta: "Tony · desktop:learning · 7ms" })];
    expect(settleAnsweredCard(phone, "a2")[0]).toMatchObject({ id: "a1", memoryEnd: "saved" });
    // The model saying the failed-save words is not Rust's reply: the walk stops there (that reply had no card).
    const model = [proposal, yes("u1"), failed("f1", "lmstudio · 812ms"), yes("u2"), turn("a2", "agent", SAVED_REPLY, { meta: "learning · 4ms" })];
    expect(settleAnsweredCard(model, "a2")).toBe(model);
  });

  it("a newer proposal in another Tony thread took Rust's app-wide spoken batch: the older card stays live", () => {
    const A = turn("a1", "agent", `Call you Nic? ${CORE_QUESTION}`, { pendingMemory: card, memoryExpiresAt: T0 + PROPOSAL_TTL_MS });
    const cardB: PendingMemory[] = [{ id: `mem-${T0 + 60_000}-9`, category: "preference", text: "When Nic is driving: keep it short" }];
    const B = turn("b1", "agent", `Keep it short when you drive? ${CORE_QUESTION}`, { thread: "general", pendingMemory: cardB, memoryExpiresAt: T0 + 60_000 + PROPOSAL_TTL_MS });
    const saved = (thread: string) => turn("a2", "agent", SAVED_REPLY, { thread, meta: "learning · 4ms" });
    // Command section ("auto") card A, then Agents > Tony ("general") card B, then a yes back in "auto":
    // Rust committed B (its spoken batch), not A, so A must not read Saved.
    const back = [A, turn("u0", "user", "when I'm driving keep it short", { thread: "general" }), B, turn("u1", "user", "yes"), saved("auto")];
    expect(settleAnsweredCard(back, "a2")).toBe(back);
    // Also when B was answered by its own buttons since (it carried a card) or after a failed save in "auto".
    const tapped = [A, { ...B, pendingMemory: undefined }, turn("u1", "user", "yes"), saved("auto")];
    expect(settleAnsweredCard(tapped, "a2")).toBe(tapped);
    const retry = [A, turn("u1", "user", "yes"), turn("f1", "agent", SAVE_FAILED_REPLY, { meta: "learning · 3ms" }), B, turn("u2", "user", "yes"), saved("auto")];
    expect(settleAnsweredCard(retry, "a2")).toBe(retry);
    // The yes in B's own thread answered B: B ends, A stays live.
    const own = [A, B, turn("u1", "user", "yes", { thread: "general" }), saved("general")];
    const out = settleAnsweredCard(own, "a2");
    expect(out[1]).toMatchObject({ id: "b1", memoryEnd: "saved" });
    expect(out[0]).toBe(A);
  });

  it("answeringIds: the ids on the card of the thread's newest agent reply, past Rust's failed saves", () => {
    const cardB: PendingMemory[] = [{ id: `mem-${T0 + 60_000}-9`, category: "preference", text: "When Nic is driving: keep it short" }];
    const A = turn("a1", "agent", `Call you Nic? ${CORE_QUESTION}`, { pendingMemory: card });
    const B = turn("b1", "agent", `Keep it short? ${CORE_QUESTION}`, { thread: "general", pendingMemory: cardB });
    // Rust pins: the request carries `answering`, the answer `answeredMemory`, and take_spoken_for checks them.
    expect(agents).toContain("pub(crate) answering: Option<Vec<String>>,");
    expect(agents).toContain("pub(crate) answered_memory: Option<AnsweredMemory>,");
    expect(rs).toContain("pub fn take_spoken_for(&self, ids: Option<&[String]>, now: u64) -> Vec<Proposal>");
    const list = [A, turn("u0", "user", "drive short", { thread: "general" }), B, turn("u1", "user", "yes")];
    expect(answeringIds(list, "auto")).toEqual([card[0].id]); // A's card, never B's from the other thread
    expect(answeringIds(list, "general")).toEqual([cardB[0].id]);
    // Past Rust's failed save (it asks again about the same batch); not past the model's own words.
    const failed = turn("f1", "agent", SAVE_FAILED_REPLY, { meta: "learning · 3ms" });
    expect(answeringIds([A, turn("u1", "user", "yes"), failed], "auto")).toEqual([card[0].id]);
    expect(answeringIds([A, { ...failed, meta: "lmstudio · 9ms" }], "auto")).toEqual([]);
    // A newest reply with no card: a yes answers nothing. No agent turn in this thread yet: no
    // card here either, so never Rust's id-less rule (it would take another thread's batch).
    expect(answeringIds([A, turn("a2", "agent", "Sure.")], "auto")).toEqual([]);
    expect(answeringIds([turn("u1", "user", "yes")], "auto")).toEqual([]);
    expect(answeringIds([A, turn("u1", "user", "yes", { thread: "general" })], "general")).toEqual([]);
  });

  it("answeredMemory: Rust named the ids it answered, so exactly that card ends, in any thread", () => {
    const cardB: PendingMemory[] = [{ id: `mem-${T0 + 60_000}-9`, category: "preference", text: "When Nic is driving: keep it short" }];
    const A = turn("a1", "agent", `Call you Nic? ${CORE_QUESTION}`, { pendingMemory: card });
    const B = turn("b1", "agent", `Keep it short? ${CORE_QUESTION}`, { thread: "general", pendingMemory: cardB });
    const answer = (approved: boolean, ids: string[], text = approved ? SAVED_REPLY : DISCARDED_REPLY) => turn("a2", "agent", text, { meta: "learning · 4ms", answeredMemory: { ids, approved } });
    // The heuristic would refuse here (B proposed in between); the ids settle A exactly.
    const named = settleAnsweredCard([A, B, turn("u1", "user", "yes"), answer(true, [card[0].id])], "a2");
    expect(named[0]).toMatchObject({ id: "a1", memoryEnd: "saved", rev: 1 });
    expect(named[1]).toBe(B);
    // A no names B, from another thread: B ends as skipped, A stays live.
    const no = settleAnsweredCard([A, B, turn("u1", "user", "no"), answer(false, [cardB[0].id])], "a2");
    expect([no[0], no[1].memoryEnd]).toEqual([A, "skipped"]);
    expect(settleAnsweredCard([A, B, answer(true, [card[0].id], ALREADY_REPLY)], "a2")[0].memoryEnd).toBe("known");
    // Ids nobody holds (or an ended card): nothing changes. The model's own turn never counts.
    const unknown = [A, answer(true, ["mem-1-1"])];
    expect(settleAnsweredCard(unknown, "a2")).toBe(unknown);
    const ended = [{ ...A, memoryEnd: "gone" as const }, answer(true, [card[0].id])];
    expect(settleAnsweredCard(ended, "a2")).toBe(ended);
    const model = [A, { ...answer(true, [card[0].id]), meta: "lmstudio · 9ms" }];
    expect(settleAnsweredCard(model, "a2")).toBe(model);
    // From the gateway: well-formed or nothing.
    expect(answeredMemoryOf({ ids: [card[0].id, "../x", 3], approved: true })).toEqual({ ids: [card[0].id], approved: true });
    for (const bad of [null, "x", { ids: [card[0].id] }, { ids: "a", approved: true }, { ids: ["../x"], approved: false }]) expect(answeredMemoryOf(bad)).toBeUndefined();
  });

  it("endCardsBefore: a desktop restart ends every live card proposed before it, and only those", () => {
    const old = turn("a1", "agent", CORE_QUESTION, { pendingMemory: card, memoryExpiresAt: T0 + PROPOSAL_TTL_MS });
    const fresh = turn("a2", "agent", CORE_QUESTION, { pendingMemory: [{ ...card[0], id: `mem-${T0 + 60_000}-9` }], memoryExpiresAt: T0 + 60_000 + PROPOSAL_TTL_MS });
    const legacy = turn("a3", "agent", CORE_QUESTION, { pendingMemory: [{ ...card[0], id: "mem-1-2" }], at: T0 + 10 }); // stored before expiries were
    const saved = turn("a4", "agent", CORE_QUESTION, { pendingMemory: card, memoryEnd: "saved" });
    const out = endCardsBefore([old, fresh, legacy, saved], T0 + 30_000);
    expect(out.map((t) => t.memoryEnd)).toEqual(["gone", undefined, "gone", "saved"]);
    expect(out[0].rev).toBe(1); // a newer revision, so the phone mirror takes it
    expect(out[1]).toBe(fresh);
    const none = [fresh, saved];
    expect(endCardsBefore(none, T0 + 30_000)).toBe(none);
  });
});
