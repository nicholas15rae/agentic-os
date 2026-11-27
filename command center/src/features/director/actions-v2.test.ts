import { describe, expect, it } from "vitest";
import type { Note, ShotSlot } from "./contract";
import { ASSETS, manifest } from "./fixtures.test-util";
import { parseDirectorActions, revisePlanBody, validateAction } from "./actions";
import { addSlot } from "./manifest";

const slots: ShotSlot[] = addSlot(addSlot(addSlot(manifest(), { label: "Hook" }), { label: "Slate", kind: "image" }), { label: "VO", kind: "audio" }).shotList; // s1 video, s2 image, s3 audio
const note = (id: string, resolved = false): Note => ({ id, renderId: "r-1", atSec: 2, text: "tighter open", by: "nic", viaVoice: false, resolved, at: "t" });
const ctx = { assets: ASSETS, manifest: { shotList: slots, notes: [note("n-1"), note("n-2"), note("n-old", true)] } };
const bad = (json: unknown, msg: string | RegExp) => expect(validateAction(json, ctx)).toMatchObject({ ok: false, error: typeof msg === "string" ? expect.stringContaining(msg) : expect.stringMatching(msg) });

describe("draft_brief", () => {
  const brief = { idea: " A moody dance reel ", goal: "get booked", platform: "reels", lengthSec: 2, aspect: "9:16", tone: "moody", references: [" like X's reels "], guessed: ["lengthSec", "tone"] };
  it("parses, trims and clamps; optional fields default", () => {
    expect(validateAction({ type: "draft_brief", brief }, ctx)).toEqual({
      ok: true,
      action: { type: "draft_brief", brief: { idea: "A moody dance reel", goal: "get booked", platform: "reels", lengthSec: 5, aspect: "9:16", tone: "moody", references: ["like X's reels"], guessed: ["lengthSec", "tone"] } },
    });
    expect(validateAction({ type: "draft_brief", brief: { idea: "x", platform: "youtube", lengthSec: 9999, aspect: "16:9" } }, ctx)).toMatchObject({ ok: true, action: { brief: { goal: "", tone: "", references: [], guessed: [], lengthSec: 600 } } });
  });
  it("rejects approval fields, unknown enums, bad guessed lists and empty ideas", () => {
    bad({ type: "draft_brief", brief: { ...brief, approved: true } }, '"approved"');
    bad({ type: "draft_brief", brief: { ...brief, updatedBy: "nic" } }, '"updatedBy"');
    bad({ type: "draft_brief", brief: { ...brief, platform: "myspace" } }, "platform");
    bad({ type: "draft_brief", brief: { ...brief, aspect: "21:9" } }, "aspect");
    bad({ type: "draft_brief", brief: { ...brief, guessed: ["approved"] } }, "guessed");
    bad({ type: "draft_brief", brief: { ...brief, guessed: ["tone", "tone"] } }, "repeats");
    bad({ type: "draft_brief", brief: { ...brief, idea: "  " } }, "empty idea");
    bad({ type: "draft_brief", brief: { ...brief, references: Array(11).fill("r") } }, "more than 10");
    bad({ type: "draft_brief", brief: { ...brief, references: [""] } }, "empty");
    bad({ type: "draft_brief", brief, extra: 1 }, '"extra"');
  });
});

describe("populate_shot_list v2", () => {
  it("takes framing / action / source / phone tips", () => {
    const r = validateAction({ type: "populate_shot_list", slots: [{ id: "s1", label: "Hook", kind: "video", targetSec: 3, framing: "closeup", action: " spin into frame ", source: "film", phoneTips: ["lock exposure on your face", "1080p 30"] }, { id: "s2", label: "B-roll", kind: "video", source: "stock", framing: null }] }, ctx);
    expect(r).toEqual({
      ok: true,
      action: {
        type: "populate_shot_list",
        slots: [
          { id: "s1", label: "Hook", instructions: "", kind: "video", targetSec: 3, framing: "closeup", action: "spin into frame", source: "film", phoneTips: ["lock exposure on your face", "1080p 30"] },
          { id: "s2", label: "B-roll", instructions: "", kind: "video", targetSec: null, framing: null, action: "", source: "stock", phoneTips: [] },
        ],
      },
    });
  });
  it("rejects bad framing / source, too many tips and Nic's fields", () => {
    const s = { id: "s1", label: "Hook", kind: "video" };
    bad({ type: "populate_shot_list", slots: [{ ...s, framing: "dutch" }] }, "framing");
    bad({ type: "populate_shot_list", slots: [{ ...s, source: "steal" }] }, "source");
    bad({ type: "populate_shot_list", slots: [{ ...s, phoneTips: ["a", "b", "c", "d", "e"] }] }, "more than 4");
    bad({ type: "populate_shot_list", slots: [{ ...s, filmed: true }] }, '"filmed"');
    bad({ type: "populate_shot_list", slots: [{ ...s, status: "approved" }] }, '"status"');
  });
});

describe("match_footage", () => {
  it("pairs assets with slots of the same kind and clamps moments", () => {
    const r = validateAction({ type: "match_footage", matches: [{ assetId: "a-v1", slotId: "s1", reason: "best take" }, { assetId: "a-img", slotId: "s2" }], moments: [{ assetId: "a-v2", inSec: -1, outSec: 99, label: "laugh", score: 3 }, { assetId: "a-mus", inSec: 1, outSec: 2, label: "drop" }] }, ctx);
    expect(r).toEqual({
      ok: true,
      action: {
        type: "match_footage",
        matches: [
          { assetId: "a-v1", slotId: "s1", reason: "best take" },
          { assetId: "a-img", slotId: "s2", reason: "" },
        ],
        moments: [
          { assetId: "a-v2", inSec: 0, outSec: 4, label: "laugh", score: 1 },
          { assetId: "a-mus", inSec: 1, outSec: 2, label: "drop", score: 0.5 },
        ],
      },
    });
    expect(validateAction({ type: "match_footage", moments: [{ assetId: "a-v1", inSec: 0, outSec: 1, label: "", score: 0.2 }] }, ctx)).toMatchObject({ ok: true, action: { matches: [] } });
  });
  it("rejects ghosts, kind mismatches, double-matched slots, stills as moments and empty blocks", () => {
    bad({ type: "match_footage", matches: [{ assetId: "a-ghost", slotId: "s1" }] }, "not in this project");
    bad({ type: "match_footage", matches: [{ assetId: "a-v1", slotId: "s9" }] }, "not in the shot list");
    bad({ type: "match_footage", matches: [{ assetId: "a-v1", slotId: "s2" }] }, "wants image");
    bad({ type: "match_footage", matches: [{ assetId: "a-v1", slotId: "s1" }, { assetId: "a-v2", slotId: "s1" }] }, "matched twice");
    bad({ type: "match_footage", moments: [{ assetId: "a-img", inSec: 0, outSec: 1, label: "", score: 1 }] }, "still");
    bad({ type: "match_footage", matches: [], moments: [] }, "no matches or moments");
    bad({ type: "match_footage", matches: [{ assetId: "a-v1", slotId: "s1", attach: true }] }, '"attach"');
    expect(validateAction({ type: "match_footage", matches: [{ assetId: "a-v1", slotId: "s1" }] }, { assets: ASSETS })).toMatchObject({ ok: false, error: expect.stringContaining("shot list") });
  });
});

describe("propose_edit_plan v2", () => {
  const clip = { assetId: "a-v1", inSec: 0, outSec: 2 };
  it("takes transitions, punch-in, audio fades / ducking, captions, color and outputs (clamped)", () => {
    const r = validateAction(
      {
        type: "propose_edit_plan",
        clips: [
          { ...clip, transitionIn: { kind: "crossfade", ms: 9000 }, punchIn: 3 },
          { ...clip, transitionIn: { kind: "cut", ms: 500 } },
        ],
        audio: [{ assetId: "a-mus", fadeInMs: 20_000, fadeOutMs: 800, duckUnderVoice: true }],
        output: {},
        captions: { enabled: true, style: "bold_pop", position: "middle", maxWordsPerLine: 40 },
        color: { preset: "warm", strength: 2 },
        outputs: ["reels", "youtube"],
        note: "",
      },
      ctx,
    );
    expect(r).toMatchObject({
      ok: true,
      action: {
        clips: [
          { transitionIn: { kind: "crossfade", ms: 1500 }, punchIn: 1.5 },
          { transitionIn: { kind: "cut", ms: 0 }, punchIn: 1 },
        ],
        audio: [{ fadeInMs: 10_000, fadeOutMs: 800, duckUnderVoice: true }],
        captions: { enabled: true, style: "bold_pop", position: "middle", maxWordsPerLine: 12 },
        color: { preset: "warm", strength: 1 },
        outputs: ["reels", "youtube"],
      },
    });
  });
  it("leaves captions / color / outputs out when the plan does", () => {
    const r = validateAction({ type: "propose_edit_plan", clips: [clip], audio: [], output: {}, note: "" }, ctx);
    expect(r.ok && Object.keys(r.action)).toEqual(["type", "clips", "audio", "output", "note"]);
  });
  it("rejects bad enums, unknown keys, duplicate / too many outputs", () => {
    const plan = (p: Record<string, unknown>) => ({ type: "propose_edit_plan", clips: [clip], audio: [], output: {}, note: "", ...p });
    bad(plan({ clips: [{ ...clip, transitionIn: { kind: "wipe", ms: 1 } }] }), "transitionIn");
    bad(plan({ clips: [{ ...clip, transitionIn: { kind: "cut", ms: 0, ease: 1 } }] }), '"ease"');
    bad(plan({ audio: [{ assetId: "a-mus", duckUnderVoice: "yes" }] }), "true or false");
    bad(plan({ captions: { style: "comic" } }), "style");
    bad(plan({ captions: { font: "Arial" } }), '"font"');
    bad(plan({ color: { preset: "teal" } }), "preset");
    bad(plan({ outputs: ["reels", "reels"] }), "twice");
    bad(plan({ outputs: ["reels", "tiktok", "shorts", "youtube", "ig_feed"] }), "more than 4");
    bad(plan({ outputs: [] }), "empty");
    bad(plan({ outputs: ["snapchat"] }), "outputs");
  });
});

describe("revise_edit", () => {
  const plan = { clips: [{ assetId: "a-v2", inSec: 0, outSec: 3 }], audio: [], output: {}, note: "faster" };
  it("validates the plan body like propose_edit_plan and checks the notes", () => {
    const r = validateAction({ type: "revise_edit", round: 1, resolves: ["n-1", "n-2"], plan, summary: "Cut the intro" }, ctx);
    expect(r).toMatchObject({ ok: true, action: { type: "revise_edit", round: 1, resolves: ["n-1", "n-2"], summary: "Cut the intro" } });
    if (r.ok && r.action.type === "revise_edit") expect(revisePlanBody(r.action).clips[0]).toEqual({ assetId: "a-v2", inSec: 0, outSec: 3, fadeMs: 0, transitionIn: { kind: "cut", ms: 0 }, punchIn: 1 });
  });
  it("rejects bad rounds, unknown / resolved / repeated notes and bad plans", () => {
    const rev = (p: Record<string, unknown>) => ({ type: "revise_edit", round: 1, resolves: ["n-1"], plan, summary: "", ...p });
    bad(rev({ round: 3 }), '"round" must be 1 or 2');
    bad(rev({ resolves: [] }), "names no notes");
    bad(rev({ resolves: ["n-9"] }), "not in this project");
    bad(rev({ resolves: ["n-old"] }), "already resolved");
    bad(rev({ resolves: ["n-1", "n-1"] }), "twice");
    bad(rev({ plan: { ...plan, type: "propose_edit_plan" } }), '"type"');
    bad(rev({ plan: { ...plan, clips: [{ assetId: "a-ghost", inSec: 0, outSec: 1 }] } }), "not in this project");
    bad(rev({ plan: "redo it" }), '"plan" must be an object');
  });
});

describe("report_open_decisions", () => {
  it("takes 1–10 non-empty items", () => {
    expect(validateAction({ type: "report_open_decisions", items: [" music or no music? "] }, ctx)).toEqual({ ok: true, action: { type: "report_open_decisions", items: ["music or no music?"] } });
    bad({ type: "report_open_decisions", items: [] }, "no items");
    bad({ type: "report_open_decisions", items: Array(11).fill("x") }, "more than 10");
    bad({ type: "report_open_decisions", items: [""] }, "empty");
  });
});

it("every v2 action type parses out of a reply in order", () => {
  const b = (j: unknown) => "```director-action\n" + JSON.stringify(j) + "\n```";
  const t = [
    "Here's what I'd do.",
    b({ type: "draft_brief", brief: { idea: "x", platform: "reels", lengthSec: 15, aspect: "9:16" } }),
    b({ type: "match_footage", matches: [{ assetId: "a-v1", slotId: "s1" }] }),
    b({ type: "revise_edit", round: 1, resolves: ["n-1"], plan: { clips: [{ assetId: "a-v1", inSec: 0, outSec: 1 }] } }),
    b({ type: "report_open_decisions", items: ["end card?"] }),
  ].join("\n");
  const r = parseDirectorActions(t, ctx);
  expect(r.errors).toEqual([]);
  expect(r.actions.map((a) => a.type)).toEqual(["draft_brief", "match_footage", "revise_edit", "report_open_decisions"]);
  expect(r.prose).toBe("Here's what I'd do.");
});
