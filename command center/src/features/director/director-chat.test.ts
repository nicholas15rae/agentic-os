import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineManifest } from "./contract";
import { ASSETS, manifest, project } from "./fixtures.test-util";

vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: vi.fn() }) } }));
vi.mock("@/lib/platform", () => ({ onNativeEvent: vi.fn(async () => () => undefined) }));
vi.mock("./api", () => ({
  api: {
    projectGet: vi.fn(),
    chatLog: vi.fn(),
    manifestSave: vi.fn(),
    renderPlan: vi.fn(),
    reviewGet: vi.fn(),
    deliverablesGet: vi.fn(),
    turn: vi.fn(),
  },
  onDirectorEvent: vi.fn(async () => () => undefined),
}));

const { api } = await import("./api");
const store = await import("./director-store");
const { allowActions, sendDirectorTurn } = await import("./director-chat");
const { addSlot } = await import("./manifest");
const m = vi.mocked(api);
const st = () => store.useDirector.getState();

const block = (o: unknown) => "```director-action\n" + JSON.stringify(o) + "\n```";
const MATCH = { type: "match_footage", matches: [{ assetId: "a-v1", slotId: "s1", reason: "best take" }], moments: [] };
const PLAN = { type: "propose_edit_plan", clips: [{ assetId: "a-v2", inSec: 0, outSec: 2 }], audio: [], output: {}, note: "" };
const SLOTS = { type: "populate_shot_list", slots: [{ id: "z1", label: "Other", instructions: "", kind: "video", targetSec: 3 }] };
const REPLY = `Here are matches.\n${block(MATCH)}\n${block(PLAN)}\n${block(SLOTS)}`;

let base: TimelineManifest;
beforeEach(async () => {
  vi.clearAllMocks();
  base = manifest({ shotList: addSlot(manifest(), { label: "Hook" }).shotList, clips: [{ id: "c-nic", assetId: "a-v1", inSec: 0, outSec: 5, fadeMs: 0, transitionIn: { kind: "cut", ms: 0 }, punchIn: 1 }] });
  m.projectGet.mockResolvedValue({ project: project(), assets: ASSETS, manifest: base, renders: [] });
  m.chatLog.mockResolvedValue([]);
  m.reviewGet.mockResolvedValue({ rounds: [], openDecisions: [] });
  m.manifestSave.mockImplementation(async ({ manifest: x }) => ({ ...x, revision: x.revision + 1 }));
  m.turn.mockResolvedValue({ answer: REPLY, providerId: "local", latencyMs: 1, answeredBy: "director" });
  store.resetDirectorStore();
  await store.openProject("demo");
});

describe("automatic turns apply only suggestions (safety-1)", () => {
  it("allowActions (pure) keeps the allowed types and lists the rest", () => {
    const acts = [MATCH, PLAN] as never[];
    expect(allowActions(acts)).toEqual({ actions: acts, refused: [] });
    const r = allowActions(acts, ["match_footage"]);
    expect(r.actions).toEqual([MATCH]);
    expect(r.refused[0]).toMatch(/^propose_edit_plan: not applied on an automatic turn/);
  });

  it("an auto reply carrying an edit plan and a shot list changes nothing but the suggestions", async () => {
    expect(await sendDirectorTurn("[auto] match these", { only: store.AUTO_TURN_ACTIONS })).toBe(true);
    expect(st().manifest).toEqual(base);
    expect(m.manifestSave).not.toHaveBeenCalled();
    expect(m.renderPlan).not.toHaveBeenCalled();
    expect(st().matchSuggestions.map((x) => `${x.slotId}=${x.assetId}`)).toEqual(["s1=a-v1"]);
    const bubble = st().chat[st().chat.length - 1];
    expect(bubble.errors?.join(" ")).toMatch(/propose_edit_plan: not applied.*populate_shot_list: not applied/);
    expect(bubble.undoId).toBeUndefined();
  });

  it("a turn Nic sends applies them, with an undo point on the bubble (safety-2); a busy chat sends nothing", async () => {
    expect(await sendDirectorTurn("tighten it")).toBe(true);
    expect(st().manifest?.clips.map((c) => c.assetId)).toEqual(["a-v2"]);
    const bubble = st().chat[st().chat.length - 1];
    expect(bubble.undoId).toBe(st().undo?.id);
    expect(await store.undoDirectorEdit()).toBe(true);
    expect(st().manifest?.clips).toEqual(base.clips);
    expect(st().manifest?.shotList).toEqual(base.shotList);
    store.useDirector.setState({ chatBusy: true });
    expect(await sendDirectorTurn("again")).toBe(false);
  });
});
