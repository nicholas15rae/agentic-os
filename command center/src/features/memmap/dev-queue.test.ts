import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DevTask, TraceStep } from "@/lib/platform";

/**
 * P6 Claude Code fix queue, webview half: recent errors are failed steps only (capped, scrubbed),
 * a live run ALWAYS goes through the confirmation card before `approved: true`, and live-run
 * progress stays in memory (never localStorage).
 */
const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  const ls = { getItem: vi.fn((k: string) => store.get(k) ?? null), setItem: vi.fn((k: string, v: string) => void store.set(k, String(v))), removeItem: vi.fn(), clear: vi.fn(), key: () => null, length: 0 };
  Object.assign(globalThis, { localStorage: ls });
  return { cmd: vi.fn(), requestConfirmation: vi.fn(), toast: vi.fn(), ls, events: [] as string[] };
});

vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => true, onNativeEvent: async (e: string) => (h.events.push(e), () => undefined), platform: "desktop" }));
vi.mock("@/features/voice/voice-controller", () => ({ requestConfirmation: h.requestConfirmation }));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: h.toast }) } }));
vi.mock("@/features/orchestrator/plan", () => ({
  heuristicPlan: (utterance: string) => ({ id: "plan-1", utterance, target: { kind: "none" }, payload: {}, mutating: false, summary: "", intent: "", readBack: "", verification: { status: "unverified", notes: [] } }),
}));
vi.mock("@/stores/nav", () => ({ useNav: { getState: () => ({ section: "memorymap" }) } }));
vi.mock("@/stores/settings", () => ({
  isDesktopApp: () => true,
  isAndroidApp: () => false, useSettings: { getState: () => ({ systemMapMode: "xray" }) } }));
vi.mock("@/features/voice/voice-store", () => ({ useVoice: { getState: () => ({ state: "idle", activeThread: "general" }) } }));

const { dispatchFix, matchFix, pushProgress, queueFix, recentErrors, useFixProgress, FIX_ERRORS_MAX, PROGRESS_MAX } = await import("./dev-queue");
const { useTrace } = await import("./trace-store");

const ID = "0a1b2c3d-1111-4222-8333-444455556666";

function step(i: number, ok: boolean, error?: string): TraceStep {
  return { traceId: `t${i}`, seq: i, hop: "tool", zone: "exhaust", label: `spotify.play ${i}`, ok, ms: 5, error, at: 1000 + i };
}

function task(over: Partial<DevTask>): DevTask {
  return { id: ID, title: "Mic stutters after a barge-in", category: "ui", priority: 1, status: "Queued", contextSnapshot: {}, kind: "fix", body: "", source: "voice", createdAt: 1, updatedAt: 1, dispatch: {}, tags: [], ...over };
}

beforeEach(() => {
  h.cmd.mockReset();
  h.requestConfirmation.mockReset();
  h.toast.mockReset();
  h.ls.setItem.mockClear();
  useFixProgress.setState({ lines: {} });
});

describe("recentErrors", () => {
  it("takes only failed steps, newest 20, scrubbed", () => {
    const secret = "sk-ant-api03-PlantedWebviewSecret00";
    const steps = Array.from({ length: 60 }, (_, i) => step(i, i % 2 === 1 ? false : true, `HTTP 401 ${secret}`));
    const errs = recentErrors(steps);
    expect(errs).toHaveLength(FIX_ERRORS_MAX);
    expect(errs.every((e) => e.source === "trace")).toBe(true);
    expect(errs[errs.length - 1].label).toBe("spotify.play 59");
    expect(errs[0].label).toBe("spotify.play 21");
    expect(JSON.stringify(errs)).not.toContain("PlantedWebviewSecret");
    expect(Object.keys(errs[0]).sort()).toEqual(["at", "error", "hop", "label", "source"]);
    expect(recentErrors([step(1, true)])).toEqual([]);
    expect(recentErrors([step(1, false)])[0].error).toBe("failed");
  });
});

describe("queueFix", () => {
  it("sends the failed steps and the UI route to dev_fix_queue", async () => {
    Object.assign(globalThis, { location: { hash: "#/memorymap" } });
    useTrace.setState({ steps: [step(1, false, "boom"), step(2, true)] });
    h.cmd.mockResolvedValue(task({}));
    await queueFix({ title: "the duck stays on", source: "voice" });
    expect(h.cmd).toHaveBeenCalledTimes(1);
    const [name, args] = h.cmd.mock.calls[0];
    expect(name).toBe("dev_fix_queue");
    expect(args.title).toBe("the duck stays on");
    expect(args.errors).toEqual([{ source: "trace", at: 1001, hop: "tool", label: "spotify.play 1", error: "boom" }]);
    expect(args.ui).toMatchObject({ route: "#/memorymap", section: "memorymap", viewMode: "xray" });
    expect(args.approved).toBeUndefined();
  });
});

describe("dispatchFix", () => {
  it("always raises the confirmation card before any approved:true call", async () => {
    h.cmd.mockResolvedValue(task({ status: "In Progress", dispatch: { state: "running" } }));
    const p = dispatchFix(task({}));
    await vi.waitFor(() => expect(h.requestConfirmation).toHaveBeenCalledTimes(1));
    // Nothing reached Rust before the yes — not even an unapproved probe.
    expect(h.cmd).not.toHaveBeenCalled();
    const plan = h.requestConfirmation.mock.calls[0][0];
    expect(plan.mutating).toBe(true);
    expect(plan.target).toMatchObject({ kind: "bridge", action: "claude-dispatch" });
    expect(plan.summary).toContain("Mic stutters after a barge-in");
    expect(plan.summary).toContain("fix/0a1b2c3d");
    await plan.run();
    expect(h.cmd).toHaveBeenCalledWith("dev_fix_dispatch", { id: ID, approved: true });
    await expect(p).resolves.toMatchObject({ status: "In Progress" });
  });

  it("a cancelled card runs nothing", async () => {
    const p = dispatchFix(task({}), "voice");
    await vi.waitFor(() => expect(h.requestConfirmation).toHaveBeenCalledTimes(1));
    expect(h.requestConfirmation.mock.calls[0][1]).toBe("voice");
    h.requestConfirmation.mock.calls[0][0].onCancel();
    await expect(p).resolves.toBeNull();
    expect(h.cmd).not.toHaveBeenCalled();
  });

  it("a Deny tier after the yes is reported, never retried", async () => {
    h.cmd.mockRejectedValue("PERMISSION_DENIED:execute");
    const settled = dispatchFix(task({})).catch((e: unknown) => e);
    await vi.waitFor(() => expect(h.requestConfirmation).toHaveBeenCalledTimes(1));
    await expect(h.requestConfirmation.mock.calls[0][0].run()).rejects.toBe("PERMISSION_DENIED:execute");
    await expect(settled).resolves.toBe("PERMISSION_DENIED:execute");
    expect(h.cmd).toHaveBeenCalledTimes(1);
  });
});

describe("live-run progress", () => {
  it("updates the in-memory tail and never touches localStorage", () => {
    for (let i = 0; i < PROGRESS_MAX + 5; i++) pushProgress({ id: ID, phase: "tool", text: `Edit ${i}`, at: i });
    pushProgress({ id: ID, phase: "text", text: "token=abcdef1234567890 leaked" });
    const lines = useFixProgress.getState().lines[ID];
    expect(lines).toHaveLength(PROGRESS_MAX);
    expect(lines[lines.length - 1].text).toContain("[redacted]");
    expect(lines[lines.length - 1].text).not.toContain("abcdef1234567890");
    // Malformed payloads are dropped.
    pushProgress({ id: "../x", phase: "tool", text: "x" });
    pushProgress({ id: ID, phase: "shell", text: "x" });
    pushProgress(null);
    expect(useFixProgress.getState().lines[ID]).toHaveLength(PROGRESS_MAX);
    expect(Object.keys(useFixProgress.getState().lines)).toEqual([ID]);
    expect(h.ls.setItem).not.toHaveBeenCalled();
  });
});

describe("matchFix", () => {
  const tasks = [
    task({ id: "11111111-1111-4111-8111-111111111111", title: "Mic stutters after a barge-in", createdAt: 1 }),
    task({ id: "22222222-2222-4222-8222-222222222222", title: "GitHub 401 loop", createdAt: 2 }),
    task({ id: "33333333-3333-4333-8333-333333333333", title: "HUD flicker", status: "Done", createdAt: 3 }),
    task({ id: "44444444-4444-4444-8444-444444444444", title: "Mic level meter wrong", kind: "task", createdAt: 4 }),
  ];
  it("finds the open fix a spoken name refers to", () => {
    expect(matchFix(tasks, "mic")?.title).toBe("Mic stutters after a barge-in");
    expect(matchFix(tasks, "the 401 loop")?.title).toBe("GitHub 401 loop");
    expect(matchFix(tasks, "22222222")?.title).toBe("GitHub 401 loop");
    expect(matchFix(tasks, "HUD flicker")).toBeNull(); // done
    expect(matchFix(tasks, "spotify")).toBeNull();
    expect(matchFix(tasks, "the")).toBeNull();
  });
});
