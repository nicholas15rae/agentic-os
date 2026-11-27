import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as { name: string; args: unknown }[] }));
vi.mock("@/lib/native-ext", () => ({
  xcmd: vi.fn(async (name: string, args?: unknown) => {
    h.calls.push({ name, args });
    if (name === "trash_restore") return { id: "t-1-b-x", kind: "build", title: "Clock", deletedAt: 1, expiresAt: 2, items: [] };
    if (name === "trash_list") return [];
    return undefined;
  }),
}));

vi.mock("@/features/reminders/notify", async () => {
  const { create } = await import("zustand");
  type T = { title: string; body?: string; tone: string; actions?: { label: string; run: () => void }[] };
  const useToasts = create<{ toasts: T[]; push: (t: T) => string }>((set) => ({ toasts: [], push: (t) => (set((s) => ({ toasts: [...s.toasts, t] })), "id") }));
  return { useToasts };
});

import { useToasts } from "@/features/reminders/notify";
import { useLayout } from "@/core/widgets/layout-store";
import { deletedToast, expiresIn, removeBuildUi, TRASH_DAYS } from "./trash";

describe("trash", () => {
  beforeEach(() => {
    h.calls = [];
    useToasts.setState({ toasts: [] });
  });

  it("counts down the 30 days", () => {
    expect(TRASH_DAYS).toBe(30);
    const now = 1_000_000;
    expect(expiresIn({ expiresAt: now + 29.5 * 86_400_000 }, now)).toBe("in 30 days");
    expect(expiresIn({ expiresAt: now + 86_400_000 }, now)).toBe("in 1 day");
    expect(expiresIn({ expiresAt: now - 1 }, now)).toBe("today");
  });

  it("a delete toast offers Undo, which restores the entry and its home-page tile", async () => {
    const tile = { instanceId: "w1", type: "staged-build", x: 0, y: 0, w: 2, h: 2, config: { buildId: "b-x" } };
    const page = useLayout.getState().pages[0];
    useLayout.setState({ pages: [{ ...page, items: [...page.items, tile as never] }] });
    const ui = removeBuildUi("b-x");
    expect(ui.tiles).toHaveLength(1);
    expect(useLayout.getState().pages[0].items.some((i) => i.instanceId === "w1")).toBe(false);
    deletedToast("Clock", { buildId: "b-x", aborted: false, purged: ["C:/x"], kept: null, trashId: "t-1-b-x" }, ui);
    const t = useToasts.getState().toasts.at(-1)!;
    expect(t.body).toContain("moved to the Trash for 30 days");
    expect(t.actions?.[0].label).toBe("Undo");
    t.actions![0].run();
    await vi.waitFor(() => expect(h.calls.some((c) => c.name === "trash_restore")).toBe(true));
    expect(h.calls.find((c) => c.name === "trash_restore")?.args).toEqual({ trashId: "t-1-b-x" });
    await vi.waitFor(() => expect(useLayout.getState().pages[0].items.some((i) => i.instanceId === "w1")).toBe(true));
  });

  it("no trash id (nothing moved): no Undo button", () => {
    deletedToast("Run", { buildId: "t", aborted: true, purged: [], kept: null });
    expect(useToasts.getState().toasts.at(-1)?.actions).toBeUndefined();
    expect(useToasts.getState().toasts.at(-1)?.body).toContain("nothing to restore");
    expect(useToasts.getState().toasts.at(-1)?.body).not.toContain("Trash");
  });
});
