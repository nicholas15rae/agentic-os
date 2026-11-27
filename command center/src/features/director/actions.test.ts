import { describe, expect, it } from "vitest";
import { ASSETS } from "./fixtures.test-util";
import { extractActionBlocks, parseDirectorActions, stripActionBlocks, validateAction } from "./actions";

// v2 defaults the parser fills in (contract v2 §2, §4).
const CUT = { transitionIn: { kind: "cut", ms: 0 }, punchIn: 1 } as const;
const SLOT_V2 = { framing: null, action: "", source: "film", phoneTips: [] } as const;

const ctx = { assets: ASSETS };
const block = (json: unknown) => "```director-action\n" + (typeof json === "string" ? json : JSON.stringify(json)) + "\n```";

describe("extract", () => {
  it("no blocks → nothing, prose unchanged", () => {
    const r = parseDirectorActions("Sounds good, send me the clips.", ctx);
    expect(r).toEqual({ actions: [], errors: [], prose: "Sounds good, send me the clips." });
  });
  it("ignores other fences (```ts, ```json that names no action); a ```json action is a block (live E2E run 6)", () => {
    expect(extractActionBlocks("```ts\nconst type = \"execute_verified_render\";\n```")).toEqual([]);
    expect(extractActionBlocks("```json\n{\"type\":\"some_config\"}\n```")).toEqual([]);
    expect(extractActionBlocks("```json\n{\"type\":\"execute_verified_render\"}\n```")).toEqual(['{"type":"execute_verified_render"}']);
  });
  it("finds multiple blocks in order, CRLF tolerated, and strips them from the prose", () => {
    const t = `Here's the plan.\n\n${block({ type: "execute_verified_render" })}\n\nAnd slots:\r\n\`\`\`director-action\r\n{"type":"populate_shot_list","slots":[{"id":"s1","label":"Hook","instructions":"","kind":"video","targetSec":5}]}\r\n\`\`\``;
    expect(extractActionBlocks(t)).toHaveLength(2);
    const r = parseDirectorActions(t, ctx);
    expect(r.errors).toEqual([]);
    expect(r.actions.map((a) => a.type)).toEqual(["execute_verified_render", "populate_shot_list"]);
    expect(r.prose).toBe("Here's the plan.\n\nAnd slots:");
    expect(stripActionBlocks(block({ type: "execute_verified_render" }))).toBe("");
  });
});

describe("validation", () => {
  it("malformed JSON is reported, other blocks still apply", () => {
    const r = parseDirectorActions(`${block("{type: 'oops'")}\n${block({ type: "execute_verified_render" })}`, ctx);
    expect(r.errors).toEqual(["block 1: not valid JSON"]);
    expect(r.actions).toEqual([{ type: "execute_verified_render" }]);
  });
  it("unknown / missing type and non-objects are rejected", () => {
    expect(validateAction({ type: "delete_everything" }, ctx)).toEqual({ ok: false, error: 'unknown action type "delete_everything"' });
    expect(validateAction({}, ctx)).toMatchObject({ ok: false, error: 'missing "type"' });
    expect(validateAction([1], ctx)).toMatchObject({ ok: false });
    expect(validateAction("execute_verified_render", ctx)).toMatchObject({ ok: false });
  });
  it("unknown fields are rejected at every level", () => {
    expect(validateAction({ type: "execute_verified_render", approved: true }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining('"approved"') });
    expect(validateAction({ type: "populate_shot_list", slots: [{ id: "s1", label: "x", kind: "video", assetId: "a-v1" }] }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining('"assetId"') });
    expect(validateAction({ type: "propose_edit_plan", clips: [{ assetId: "a-v1", inSec: 0, outSec: 1, speed: 2 }], audio: [], output: {}, note: "" }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining('"speed"') });
    expect(validateAction({ type: "propose_edit_plan", clips: [{ assetId: "a-v1", inSec: 0, outSec: 1 }], audio: [], output: { codec: "h265" }, note: "" }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining('"codec"') });
  });

  it("populate_shot_list: clamps targetSec, rejects bad kinds / duplicate ids / empty", () => {
    const ok = validateAction({ type: "populate_shot_list", slots: [{ id: "s1", label: " Hook ", instructions: "Open strong", kind: "video", targetSec: 9999 }, { id: "s2", label: "Slate", kind: "image", targetSec: null }] }, ctx);
    expect(ok).toEqual({
      ok: true,
      action: {
        type: "populate_shot_list",
        slots: [
          { id: "s1", label: "Hook", instructions: "Open strong", kind: "video", targetSec: 600, ...SLOT_V2 },
          { id: "s2", label: "Slate", instructions: "", kind: "image", targetSec: null, ...SLOT_V2 },
        ],
      },
    });
    expect(validateAction({ type: "populate_shot_list", slots: [{ id: "s1", label: "x", kind: "gif" }] }, ctx)).toMatchObject({ ok: false });
    expect(validateAction({ type: "populate_shot_list", slots: [{ id: "s1", label: "a", kind: "video" }, { id: "s1", label: "b", kind: "video" }] }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining("duplicate") });
    expect(validateAction({ type: "populate_shot_list", slots: [] }, ctx)).toMatchObject({ ok: false });
    expect(validateAction({ type: "populate_shot_list", slots: Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, label: "x", kind: "video" })) }, ctx)).toMatchObject({ ok: false });
    expect(validateAction({ type: "populate_shot_list", slots: [{ id: "s 1; rm", label: "x", kind: "video" }] }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining("bad id") });
  });

  it("propose_edit_plan: clamps to the manifest rules", () => {
    const r = validateAction(
      {
        type: "propose_edit_plan",
        clips: [
          { assetId: "a-v1", inSec: -2, outSec: 50, fadeMs: 9000 },
          { assetId: "a-img", inSec: 7, outSec: 120 },
          { assetId: "a-img" },
        ],
        audio: [{ assetId: "a-mus", startSec: -1, volume: 5 }],
        output: { aspect: "9:16", loudnessLufs: -17.4, maxSizeMb: 0, name: "teaser v1?" },
        note: "Tight open.",
      },
      ctx,
    );
    expect(r).toEqual({
      ok: true,
      action: {
        type: "propose_edit_plan",
        clips: [
          { assetId: "a-v1", inSec: 0, outSec: 10, fadeMs: 2000, ...CUT },
          { assetId: "a-img", inSec: 0, outSec: 60, fadeMs: 0, ...CUT },
          { assetId: "a-img", inSec: 0, outSec: 3, fadeMs: 0, ...CUT },
        ],
        audio: [{ assetId: "a-mus", startSec: 0, inSec: 0, outSec: 30, volume: 2, fadeInMs: 0, fadeOutMs: 0, duckUnderVoice: false }],
        output: { aspect: "9:16", loudnessLufs: -18, maxSizeMb: null, name: "teaser_v1" },
        note: "Tight open.",
      },
    });
  });

  it("propose_edit_plan: asset ids must exist and fit the lane", () => {
    const plan = (clips: unknown[], audio: unknown[] = []) => ({ type: "propose_edit_plan", clips, audio, output: {}, note: "" });
    expect(validateAction(plan([{ assetId: "a-ghost", inSec: 0, outSec: 1 }]), ctx)).toMatchObject({ ok: false, error: expect.stringContaining("not in this project") });
    expect(validateAction(plan([{ assetId: "a-mus", inSec: 0, outSec: 1 }]), ctx)).toMatchObject({ ok: false, error: expect.stringContaining("audio") });
    expect(validateAction(plan([{ assetId: "a-v1", inSec: 0, outSec: 1 }], [{ assetId: "a-v2", startSec: 0 }]), ctx)).toMatchObject({ ok: false, error: expect.stringContaining("not an audio asset") });
    expect(validateAction(plan([]), ctx)).toMatchObject({ ok: false, error: expect.stringContaining("no clips") });
    expect(validateAction(plan([{ assetId: "a-v1", inSec: "0", outSec: 1 }]), ctx)).toMatchObject({ ok: false, error: expect.stringContaining("number") });
    expect(validateAction(plan([{ assetId: "a-v1", inSec: 0, outSec: 1 }]), { assets: [] })).toMatchObject({ ok: false });
    expect(validateAction({ ...plan([{ assetId: "a-v1", inSec: 0, outSec: 1 }]), output: { aspect: "21:9" } }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining("aspect") });
  });

  it("a bad block among good ones is reported by number, never half-applied", () => {
    const t = [block({ type: "execute_verified_render" }), block({ type: "propose_edit_plan", clips: [{ assetId: "a-ghost", inSec: 0, outSec: 1 }], audio: [], output: {}, note: "" }), block({ type: "nope" })].join("\n");
    const r = parseDirectorActions(t, ctx);
    expect(r.actions).toEqual([{ type: "execute_verified_render" }]);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatch(/^block 2: /);
    expect(r.errors[1]).toMatch(/^block 3: unknown action type/);
  });
});

// Live E2E 2026-11-26: Qwen 3.5-9B copied the contract's "{json}" placeholder line into every block
// ("block 1: not valid JSON" twice, so no brief). A copied placeholder line is dropped; real JSON is untouched.
describe("copied placeholder line", () => {
  const brief = '{"type":"draft_brief","brief":{"idea":"Cut my reel","platform":"reels","lengthSec":15,"aspect":"9:16","guessed":["lengthSec"]}}';
  it("drops a leading {json} / json line before the object", () => {
    for (const lead of ["{json}\n", "{ json }\r\n", "json\n"]) {
      const r = parseDirectorActions("ok\n```director-action\n" + lead + brief + "\n```", { assets: [] });
      expect(r.errors).toEqual([]);
      expect(r.actions.map((a) => a.type)).toEqual(["draft_brief"]);
    }
  });
  it("still refuses anything else that isn't JSON", () => {
    expect(parseDirectorActions("```director-action\n{brief}\n" + brief + "\n```", { assets: [] }).errors).toEqual(["block 1: not valid JSON"]);
  });
});

// Live E2E 2026-11-26: with only a video asset, Qwen put the video in "audio" (twice) and the plan
// was refused; the error now says what to do instead.
describe("video asset in audio", () => {
  it("is refused with a fix the model can act on", () => {
    const v = ASSETS.find((a) => a.kind === "video")!;
    const r = validateAction({ type: "propose_edit_plan", clips: [{ assetId: v.id, inSec: 0, outSec: 1 }], audio: [{ assetId: v.id }], output: {}, note: "" }, { assets: ASSETS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/leave "audio" \[\]/);
  });
});
