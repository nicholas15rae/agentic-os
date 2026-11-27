import { describe, expect, it } from "vitest";
import { looksLikeList, nextStreamChunk, perSentenceOpts, sentences, stripForSpeech, stripLabels, synthArgs, utteranceIdFor } from "./tts-text";

/** Live test 11-27: Tony read "Spoken reply" aloud. Internal labels and tags never reach TTS. */
describe("internal labels are stripped before speech", () => {
  it("drops a leading label in every shape", () => {
    for (const t of [
      "Spoken reply: Hey Nic, two emails in Primary.",
      "**Spoken reply:** Hey Nic, two emails in Primary.",
      "Spoken reply - Hey Nic, two emails in Primary.",
      "[Spoken reply] Hey Nic, two emails in Primary.",
      "<spoken_reply>Hey Nic, two emails in Primary.</spoken_reply>",
      "Voice summary: Hey Nic, two emails in Primary.",
      "Tony: Hey Nic, two emails in Primary.",
      "spoken_reply: Hey Nic, two emails in Primary.",
      "(internal) Hey Nic, two emails in Primary.",
    ]) {
      expect(stripForSpeech(t), t).toBe("Hey Nic, two emails in Primary.");
    }
  });

  it("drops a label after a sentence or on its own line", () => {
    expect(stripForSpeech("Got it. Spoken reply: it's from Melissa Lee.")).toBe("Got it. it's from Melissa Lee.");
    expect(stripForSpeech("Internal note: checked Primary\nReply: it's from Melissa Lee.")).toBe("checked Primary\nit's from Melissa Lee.");
    // (Sentences under 40 chars merge with the next one by design.)
    expect(sentences("Spoken reply: Melissa Lee sent the invoice. Subject is Invoice 114, Primary inbox.")).toEqual(["Melissa Lee sent the invoice. Subject is Invoice 114, Primary inbox."]);
  });

  it("leaves ordinary words alone", () => {
    for (const t of ["Her reply: no thanks.", "Reply-all to Sam later.", "Tony is busy.", "The answer is yes.", "I spoke to the output team.", "Read me the response from Sam."]) {
      expect(stripLabels(t), t).toBe(t);
    }
  });

  it("streamed chunks are stripped too (each chunk goes through stripForSpeech)", () => {
    const c = nextStreamChunk("Spoken reply: Hey Nic, Melissa Lee wrote about the invoice. ", 0);
    expect(c).not.toBeNull();
    expect(stripForSpeech(c!.chunk)).toBe("Hey Nic,");
  });
});

describe("stripForSpeech", () => {
  it("strips fenced code blocks and inline code", () => {
    expect(stripForSpeech("before ```const x = 1;``` after")).toBe("before after");
    expect(stripForSpeech("run `npm test` now")).toBe("run npm test now");
  });

  it("strips images and unwraps links to their text", () => {
    expect(stripForSpeech("see ![alt](pic.png) here")).toBe("see here");
    expect(stripForSpeech("read [the docs](https://example.com) first")).toBe("read the docs first");
  });

  it("strips headings and list markers", () => {
    expect(stripForSpeech("# Title\nSome text")).toBe("Title\nSome text");
    expect(stripForSpeech("- one\n- two\n1. three\n2) four")).toBe("one\ntwo\nthree\nfour");
  });

  it("unwraps bold, italic and strikethrough", () => {
    expect(stripForSpeech("this is **bold** and __also bold__")).toBe("this is bold and also bold");
    expect(stripForSpeech("this is *italic* and _also italic_")).toBe("this is italic and also italic");
    expect(stripForSpeech("~~gone~~")).toBe("gone");
  });

  it("removes emoji without touching ordinary punctuation", () => {
    expect(stripForSpeech("done! 🎉🔥 great job")).toBe("done! great job");
    expect(stripForSpeech("cost: $5.00 (a bargain)")).toBe("cost: $5.00 (a bargain)");
  });

  it("collapses runs of spaces/tabs but leaves newlines from list stripping alone", () => {
    expect(stripForSpeech("a   b\t\tc")).toBe("a b c");
  });
});

describe("sentences", () => {
  it("splits on sentence boundaries (each long enough not to merge with its neighbour)", () => {
    const s1 = `Alpha ${"word ".repeat(8)}end1.`; // well over 40 chars
    const s2 = `Bravo ${"word ".repeat(8)}end2.`;
    const s3 = `Charlie ${"word ".repeat(8)}end3.`;
    const out = sentences(`${s1} ${s2} ${s3}`);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(s1);
    expect(out[1]).toBe(s2);
    expect(out[2]).toBe(s3);
  });

  it("cascades short sentences together instead of leaving tiny chunks", () => {
    // Each sentence here is under 40 chars, so — matching the pre-existing merge
    // behaviour this function keeps — they all collapse into one chunk.
    expect(sentences("One. Two! Three?")).toEqual(["One. Two! Three?"]);
  });

  it("merges a short chunk forward with what follows instead of leaving it on its own", () => {
    const out = sentences("Ok. This is what happens next in the plan, in a bit more detail.");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Ok.");
    expect(out[0]).toContain("This is what happens next");
  });

  it("caps each chunk at maxChars and does not dump an unbounded tail into the last chunk", () => {
    // Seven sentences, each 300 chars — the old count-based cap (max=6) would have
    // merged everything from the 6th sentence onward into one unbounded chunk.
    const sentence = `${"word ".repeat(59)}end.`; // ~300 chars, one "sentence"
    const text = Array.from({ length: 7 }, () => sentence).join(" ");
    const out = sentences(text, 1800);
    for (const chunk of out) expect(chunk.length).toBeLessThanOrEqual(1800);
    // Nothing was dropped: every chunk's words sum back to the original.
    expect(out.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("splits a single clause longer than maxChars on a word boundary", () => {
    const text = `${"word ".repeat(500)}end.`; // ~2500 chars, no sentence breaks until the end
    const out = sentences(text, 1800);
    expect(out.length).toBeGreaterThan(1);
    for (const chunk of out) expect(chunk.length).toBeLessThanOrEqual(1800);
  });

  it("strips markdown before splitting, so chunks never carry markup", () => {
    const out = sentences("**Step one.** Then *step two*.");
    expect(out.join(" ")).not.toMatch(/[*_]/);
  });

  it("keeps a bulleted reply as one chunk instead of one request per bullet", () => {
    // Each bullet ends in a period, which — without list detection — would each become
    // its own sentence chunk (the exact "fires per bullet" bug this guards against).
    const text = "Here's the casting summary:\n- John Smith confirmed for Saturday's callback.\n- Priya Shah still pending wardrobe fitting.\n- Marcus Lee dropped out, backup notified.";
    expect(sentences(text)).toHaveLength(1);
  });

  it("keeps a numbered list as one chunk too", () => {
    const text = "1. Scene one is locked in.\n2. Scene two needs a reshoot.\n3. Scene three is still pending approval.";
    expect(sentences(text)).toHaveLength(1);
  });

  it("does not treat a single incidental dash line as a list", () => {
    // Only one marked line — normal prose, not a list — keeps ordinary sentence splitting.
    const s1 = `Alpha ${"word ".repeat(8)}end1.`;
    const s2 = `- Bravo ${"word ".repeat(8)}end2.`;
    expect(sentences(`${s1}\n${s2}`)).toHaveLength(2);
  });

  it("still caps a very long list at maxChars without dropping content", () => {
    const line = (n: number) => `- Item number ${n} with some extra detail to pad it out.`;
    const text = Array.from({ length: 40 }, (_, i) => line(i)).join("\n");
    const out = sentences(text, 500);
    expect(out.length).toBeGreaterThan(1);
    for (const chunk of out) expect(chunk.length).toBeLessThanOrEqual(500);
    expect(out.join(" ").replace(/\s+/g, " ")).toBe(stripForSpeech(text).replace(/\s+/g, " "));
  });
});

describe("sentences list join", () => {
  it("ends unpunctuated list lines with a period so bullets don't run together", () => {
    expect(sentences("Groceries:\n- eggs\n- milk\n- bread")).toEqual(["Groceries: eggs. milk. bread."]);
  });

  it("leaves list lines that already end in punctuation alone", () => {
    expect(sentences("- Call Sam back?\n- Book the room;\n- **Done.**")).toEqual(["Call Sam back? Book the room; Done."]);
  });
});

describe("looksLikeList", () => {
  it("needs two or more marked lines making up at least half the lines", () => {
    expect(looksLikeList("- a\n- b")).toBe(true);
    expect(looksLikeList("Intro\n- a\n- b\nOutro")).toBe(true);
    expect(looksLikeList("- a\nplain\nplain\nplain")).toBe(false);
  });
});

describe("nextStreamChunk", () => {
  /** Feed `text` one character at a time, collecting chunks the way osRun does. */
  const stream = (text: string) => {
    const chunks: string[] = [];
    let buffered = "";
    let spokenUpTo = 0;
    for (const ch of text) {
      buffered += ch;
      const next = nextStreamChunk(buffered, spokenUpTo);
      if (next) {
        chunks.push(next.chunk);
        spokenUpTo = next.end;
      }
    }
    return { chunks, rest: text.slice(spokenUpTo).trim() };
  };

  const first = "Alright, here's where we stand today.";
  const long1 = "The callback is set for Saturday at noon sharp.";
  const long2 = "Wardrobe still needs Priya for one more fitting.";

  it("waits for a 20+ char clause before the first chunk, then 40+ char sentences", () => {
    expect(nextStreamChunk("Sure, ", 0)).toBeNull();
    expect(nextStreamChunk("Okay, let me look into that for you. ", 0)).toEqual({ chunk: "Okay, let me look into that for you.", end: 36 });
    expect(nextStreamChunk(`${first} Short one. `, first.length)).toBeNull();
  });

  it("does not stall behind a short sentence: it is absorbed into the next long one", () => {
    const { chunks, rest } = stream(`${first} Got it. ${long1} ${long2} Done`);
    expect(chunks).toEqual([first, `Got it. ${long1}`, long2]);
    expect(rest).toBe("Done");
  });

  it("does not count leading whitespace toward a chunk's minimum length", () => {
    const { chunks } = stream(`${first}\n\n${" ".repeat(30)}Got it. ${long1} `);
    expect(chunks).toEqual([first, `Got it. ${long1}`]);
  });

  it("stops chunking once a list line streams in, leaving the list to one end-of-stream call", () => {
    const intro = "Here is the casting summary for this week in order.";
    const list = "\n- John Smith confirmed for Saturday's callback at noon.\n- Priya Shah still pending her wardrobe fitting today.\n- Marcus Lee dropped out, backup notified.";
    const { chunks, rest } = stream(`${intro}${list} Anything else?`);
    expect(chunks).toEqual([intro]);
    expect(sentences(rest)).toHaveLength(1);
  });

  it("never chunks a reply that opens with a list", () => {
    const { chunks } = stream("1. Scene one is locked in, the crew is booked.\n2. Scene two needs a reshoot next week, sadly.\n");
    expect(chunks).toEqual([]);
  });

  it("does not mistake a mid-line number for a list line", () => {
    expect(nextStreamChunk("We moved it to 3. That works for everyone involved, right? ", 0)).not.toBeNull();
  });
});

describe("perSentenceOpts / synthArgs (P1 utteranceId)", () => {
  const text = "The first sentence is long enough to stand alone. The second one is also long enough here. And a third sentence closes the reply.";

  it("the reply's utteranceId reaches every sentence while previousText still chains", () => {
    const out = perSentenceOpts(text, { agent: "general", utteranceId: "turn-1-general", previousText: "before" });
    expect(out.length).toBe(3);
    expect(out.map((o) => o.opts.utteranceId)).toEqual(["turn-1-general", "turn-1-general", "turn-1-general"]);
    expect(out.map((o) => o.opts.previousText)).toEqual(["before", out[0].s, out[1].s]);
    expect(out.every((o) => o.opts.agent === "general")).toBe(true);
  });

  it("synthArgs forwards utteranceId and previousText for a live line", () => {
    expect(synthArgs("hi", { agent: "coder", previousText: "p", utteranceId: "u-coder" })).toEqual({ text: "hi", voice: undefined, agent: "coder", previousText: "p", utteranceId: "u-coder" });
  });

  it("a cache:true line sends neither utteranceId nor previousText", () => {
    const a = synthArgs("Here's Coder.", { agent: "general", cache: true, utteranceId: "u-general", previousText: "p" });
    expect(a).toEqual({ text: "Here's Coder.", voice: undefined, agent: "general" });
    expect("utteranceId" in a).toBe(false);
  });

  it("utteranceIdFor is `${streamId}-${agent}` and always passes Rust's validation", () => {
    const id = "0b7c2f5e-8d0a-4c1e-9f3b-2a6d5e4c3b21";
    expect(utteranceIdFor(id, "general")).toBe(`${id}-general`);
    const odd = utteranceIdFor(id, "booking_desk with spaces and a very long name");
    expect(odd).toMatch(/^[A-Za-z0-9-]{1,64}$/);
  });
});

describe("synthArgs localOnly (Part 6 narration on local Kokoro)", () => {
  it("is sent only when set, on live and cached lines alike", () => {
    expect(synthArgs("Spec is in.", { agent: "prompter", localOnly: true, utteranceId: "u1" })).toMatchObject({ agent: "prompter", localOnly: true, utteranceId: "u1" });
    expect(synthArgs("Spec is in.", { agent: "prompter", cache: true, localOnly: true }, "p1")).toEqual({ text: "Spec is in.", voice: undefined, agent: "prompter", pinId: "p1", localOnly: true });
    expect("localOnly" in synthArgs("Hi.", { agent: "general" })).toBe(false);
    expect("localOnly" in synthArgs("Hi.", { agent: "general", cache: true })).toBe(false);
  });
});
