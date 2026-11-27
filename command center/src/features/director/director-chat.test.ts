import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASSETS, manifest, project } from "./fixtures.test-util";

// Learning mode: a Director-chat turn is Tony's, and Rust's spoken batch is app-wide. A yes typed
// here must carry this chat's own card ids (`answering`), never leave Rust to take the batch
// Tony's thread (or the phone) proposed last.
const h = vi.hoisted(() => ({ cmd: vi.fn(), answers: [] as unknown[] }));
vi.mock("@/lib/platform", () => ({ cmd: h.cmd, onNativeEvent: vi.fn(async () => () => undefined), isTauri: () => true }));
vi.mock("@/features/bridge/gate", () => ({ gated: (_g: unknown, run: (approved: boolean) => Promise<unknown>) => run(true) }));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: vi.fn() }) } }));
vi.mock("./api", () => ({ api: { projectGet: vi.fn(), chatLog: vi.fn(), manifestSave: vi.fn(), renderPlan: vi.fn(), renderExecute: vi.fn(), projects: vi.fn() } }));

const { api } = await import("./api");
const store = await import("./director-store");
const { directorAnswering, sendDirectorTurn } = await import("./director-chat");
const { CORE_QUESTION, SAVED_REPLY, SAVE_FAILED_REPLY } = await import("@/features/modes/learning");

const A = { id: "mem-1764000000000-1", category: "rule", text: "When Nic says cut: hard cut, no fade" };
const reqs = () => h.cmd.mock.calls.filter((c) => c[0] === "os_turn").map((c) => (c[1] as { req: { answering?: string[] } }).req);

beforeEach(async () => {
  vi.clearAllMocks();
  store.resetDirectorStore();
  vi.mocked(api.projectGet).mockResolvedValue({ project: project(), assets: ASSETS, manifest: manifest(), renders: [] });
  // A reply read back from the log (no ids): it answers nothing.
  vi.mocked(api.chatLog).mockResolvedValue([{ role: "director", text: `Old lesson? ${CORE_QUESTION}`, at: "t" }] as never);
  h.answers = [];
  h.cmd.mockImplementation(async (name: string) => (name === "os_turn" ? h.answers.shift() : undefined));
  await store.openProject("demo");
});

describe("director chat answering", () => {
  it("a yes carries the ids of this chat's newest reply, [] when it proposed nothing", async () => {
    h.answers = [
      { answer: `Hard cuts, got it. ${CORE_QUESTION}`, pendingMemory: [A] },
      { answer: SAVED_REPLY, pendingMemory: [] },
      { answer: "Sure.", pendingMemory: [] },
    ];
    await sendDirectorTurn("when I say cut, hard cut");
    await sendDirectorTurn("yes");
    await sendDirectorTurn("yes");
    const r = reqs();
    expect(r[0].answering).toEqual([]); // the logged reply has no ids: never another chat's batch
    expect(r[1].answering).toEqual([A.id]); // this chat's own card
    expect(r[2].answering).toEqual([]); // the newest reply (Saved) proposed nothing
    expect(store.useDirector.getState().chat.find((m) => m.text.startsWith("Hard cuts"))?.memoryIds).toEqual([A.id]);
  });

  it("past Rust's failed save (it asks again about the same batch); a fresh chat answers nothing", () => {
    const msg = (id: string, role: "nic" | "director", text: string, memoryIds?: string[]) => ({ id, role, text, at: "t", ...(memoryIds ? { memoryIds } : {}) });
    expect(directorAnswering([msg("1", "director", "Hard cuts?", [A.id]), msg("2", "nic", "yes"), msg("3", "director", SAVE_FAILED_REPLY)])).toEqual([A.id]);
    expect(directorAnswering([msg("1", "director", "Hard cuts?", [A.id, "../x"])])).toEqual([A.id]);
    expect(directorAnswering([msg("1", "nic", "yes")])).toEqual([]);
    expect(directorAnswering([])).toEqual([]);
  });
});
