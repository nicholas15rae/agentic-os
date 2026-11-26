import { describe, expect, it } from "vitest";
import type { MediaAsset, Note, ShotSlot, TimelineClip } from "./contract";
import { asset, manifest, project } from "./fixtures.test-util";
import { ACTION_CONTRACT, CONTEXT_BUDGET, buildDirectorContext } from "./context";

const FRAMINGS = ["wide", "medium", "mcu", "closeup", "insert"] as const;

/** A typical shooting-to-review project: 15 assets with tags, flags, transcripts and moments. */
function typical() {
  const assets: MediaAsset[] = Array.from({ length: 15 }, (_, i) => {
    const kind = i < 11 ? "video" : i < 13 ? "image" : "audio";
    return asset(`a-k${i.toString(36)}x${i}`, kind, {
      name: kind === "video" ? `IMG_${4000 + i}_take_${i}.MOV` : kind === "image" ? `slate_${i}.png` : `track_${i}.mp3`,
      durationSec: kind === "image" ? null : 12.37 + i,
      tags: kind === "video" ? ["dance", "studio", "warm light"] : [],
      flags: i % 4 === 0 && kind === "video" ? [{ kind: "dark", detail: "mean luma 38" }] : [],
      transcript: kind === "video" ? { path: `C:\\ai-hub\\media\\projects\\demo\\working\\captions\\a-${i}.json`, lang: "en", words: 40 + i, firstSpeechSec: 0.8, lastSpeechSec: 11.2 } : null,
      moments:
        kind === "video"
          ? [
              { id: `m-${i}a`, inSec: 1.2, outSec: 3.4, label: "big spin", score: 0.9, by: "director" },
              { id: `m-${i}b`, inSec: 6, outSec: 8.5, label: "laugh", score: 0.6, by: "director" },
            ]
          : [],
      slotId: i < 5 ? `s${i + 1}` : null,
    });
  });
  const shotList: ShotSlot[] = Array.from({ length: 8 }, (_, i) => ({
    id: `s${i + 1}`,
    label: `Shot ${i + 1}: ${["Hook", "Spin", "Footwork", "Close smile", "Wide combo", "Floor work", "Outro pose", "End slate"][i]}`,
    instructions: "Keep the phone at chest height.",
    kind: i === 7 ? "image" : "video",
    targetSec: 3,
    assetId: i < 5 ? assets[i].id : null,
    status: i < 5 ? "attached" : "needed",
    framing: FRAMINGS[i % FRAMINGS.length],
    action: "Hit the count of eight and hold the last pose for a beat",
    source: i === 7 ? "generate" : "film",
    phoneTips: ["lock exposure on your face", "shoot 1080p 30"],
    filmed: i < 6,
  }));
  const clips: TimelineClip[] = assets.slice(0, 10).map((a, i) => ({ id: `c-${i}`, assetId: a.id, inSec: 1.25, outSec: 4.5, fadeMs: 0, transitionIn: i ? { kind: "crossfade", ms: 300 } : { kind: "cut", ms: 0 }, punchIn: i % 3 ? 1 : 1.1 }));
  const notes: Note[] = Array.from({ length: 4 }, (_, i) => ({ id: `n-${i}`, renderId: "r-1", atSec: 2.5 + i, text: "The second spin lands late; trim the run-up and keep the smile.", by: "nic", viaVoice: i % 2 === 1, resolved: i === 0, at: "t" }));
  const m = manifest({
    clips,
    audio: [
      { id: "au-1", assetId: assets[13].id, startSec: 0, inSec: 0, outSec: 25.37, volume: 0.8, fadeInMs: 500, fadeOutMs: 1500, duckUnderVoice: true },
      { id: "au-2", assetId: assets[14].id, startSec: 4, inSec: 0, outSec: 6, volume: 1, fadeInMs: 0, fadeOutMs: 0, duckUnderVoice: false },
    ],
    shotList,
    notes,
    captions: { enabled: true, style: "bold_pop", position: "lower", maxWordsPerLine: 4 },
    color: { preset: "warm", strength: 0.4 },
    outputs: [
      { platform: "reels", aspect: "9:16", loudnessLufs: -14, maxSizeMb: null, maxSec: 90 },
      { platform: "youtube", aspect: "16:9", loudnessLufs: -14, maxSizeMb: null, maxSec: null },
    ],
  });
  const p = project({
    status: "review",
    source: { from: "brainstorm", refId: "n1", brief: "A 30 second dance reel for the studio's winter showcase, warm and playful, ending on the studio logo." },
    brief: {
      idea: "A 30 second dance reel for the studio's winter showcase, warm and playful, ending on the studio logo.",
      goal: "get booked for showcase gigs",
      platform: "reels",
      lengthSec: 30,
      aspect: "9:16",
      tone: "warm, playful, quick cuts",
      references: ["https://www.instagram.com/reel/abc123", "like the studio's spring reel"],
      guessed: ["tone"],
      approved: true,
      updatedBy: "nic",
      updatedAt: "t",
    },
  });
  const review = { rounds: [{ round: 1 as const, renderId: "r-1", notes: ["n-0", "n-1", "n-2", "n-3"], status: "open" as const, summary: "" }], openDecisions: ["Logo card or text end card?"] };
  return { p, assets, m, review };
}

describe("buildDirectorContext v2", () => {
  it(`a typical 15-asset project stays under ${CONTEXT_BUDGET} characters`, () => {
    const { p, assets, m, review } = typical();
    const c = buildDirectorContext(p, assets, m, review);
    expect(c.length).toBeLessThan(CONTEXT_BUDGET);
  });

  it("carries the brief, shot list v2, asset flags / tags / transcripts / moments, the review round and open notes", () => {
    const { p, assets, m, review } = typical();
    const c = buildDirectorContext(p, assets, m, review);
    expect(c).toContain("BRIEF (approved by Nic): reels · 30s · 9:16");
    expect(c).toContain("Tone: warm, playful, quick cuts (guessed)");
    expect(c).toContain("Brief (from brainstorm):");
    expect(c).toMatch(/- s1 Shot 1: Hook · video · film · wide · 3s · ← a-k0x0 · filmed — Hit the count/);
    expect(c).toMatch(/- s6 .* UNFILLED · filmed/);
    expect(c).toMatch(/- s8 .* image · generate .* UNFILLED/);
    expect(c).toMatch(/a-k0x0 · IMG_4000_take_0\.MOV · video · role clip · 12\.37s · 1920×1080 · slot s1 · tags dance,studio,warm light · flags dark · speech 40w 0\.8–11\.2s · moments 1\.2–3\.4 "big spin"; 6–8\.5 "laugh"/);
    expect(c).toContain('"captions":{"enabled":true,"style":"bold_pop"');
    expect(c).toContain('"outputs":["reels","youtube"]');
    expect(c).toContain('["a-k0x0",1.25,4.5,0,"cut",1.1]');
    expect(c).toContain("REVIEW: round 1 of 2 (open) on render r-1");
    expect(c).toContain("Open decisions: Logo card or text end card?");
    expect(c).toContain("OPEN NOTES (3):");
    expect(c).not.toContain("- n-0 ");
    expect(c).toContain("- n-1 on r-1 @3.5s: The second spin lands late");
    expect(c).toContain(ACTION_CONTRACT);
  });

  it("round 2 tells the Director there is no more revising; no brief / render yet reads as such", () => {
    const { p, assets, m } = typical();
    const r2 = { rounds: [{ round: 1 as const, renderId: "r-1", notes: [], status: "revised" as const, summary: "" }, { round: 2 as const, renderId: "r-2", notes: [], status: "open" as const, summary: "" }], openDecisions: [] };
    expect(buildDirectorContext(p, assets, m, r2)).toContain("REVIEW: round 2 of 2 (open) on render r-2 · no more revising: only report_open_decisions");
    const bare = buildDirectorContext(project(), [], manifest());
    expect(bare).toContain("BRIEF: none yet");
    expect(bare).toContain("SHOT LIST: empty");
    expect(bare).toContain("REVIEW: no verified render yet");
    expect(bare).toContain("OPEN NOTES: none");
    expect(bare).toContain("- (none staged yet)");
  });

  it("the action contract names every v2 action and the safety rules", () => {
    for (const t of ["draft_brief", "populate_shot_list", "match_footage", "propose_edit_plan", "revise_edit", "report_open_decisions", "execute_verified_render"]) expect(ACTION_CONTRACT).toContain(`"type":"${t}"`);
    expect(ACTION_CONTRACT).toMatch(/Only Nic approves a brief/);
    expect(ACTION_CONTRACT).toMatch(/no round 3|no more revising/);
    expect(ACTION_CONTRACT).toMatch(/CPU-only/);
    expect(ACTION_CONTRACT).toMatch(/Never claim a render ran/);
    expect(ACTION_CONTRACT).not.toMatch(/\b(he|she|his|her|him)\b/i);
  });
});
