// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

// Run the hook's effect at once (no renderer in node), give it a toast sink, and spy on the kill call.
const cleanups: unknown[] = [];
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), useEffect: (fn: () => unknown) => void cleanups.push(fn()) }));
vi.mock("@/features/reminders/notify", () => ({ useToasts: (sel: (s: { push: () => void }) => unknown) => sel({ push: () => undefined }) }));
const kill = vi.fn(async () => ({ incidentId: "i", ok: true, dryRun: false, cancelled: [], flatten: [], errors: [], steps: [] }));
vi.mock("@/features/trading/ibkr", () => ({ tradingApi: { kill: (...a: unknown[]) => kill(...(a as [])) } }));

import { useKillSwitchHotkey } from "./kill-switch";

type Listener = (e: unknown) => void;
const removed: { type: string; fn: Listener; opts: unknown }[] = [];
function fakeWindow() {
  const added: { type: string; fn: Listener; opts: unknown }[] = [];
  (globalThis as { window?: unknown }).window = {
    addEventListener: (type: string, fn: Listener, opts: unknown) => added.push({ type, fn, opts }),
    removeEventListener: (type: string, fn: Listener, opts: unknown) => removed.push({ type, fn, opts }),
  };
  return added;
}
const chord = (repeat = false) => ({ key: "X", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, repeat, preventDefault: () => undefined, stopPropagation: () => undefined });

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  kill.mockClear();
  cleanups.length = 0;
  removed.length = 0;
});

describe("useKillSwitchHotkey (the hook MainApp mounts)", () => {
  it("registers one capture-phase keydown listener that ignores a held chord and trips on 3 presses", () => {
    const added = fakeWindow();
    useKillSwitchHotkey();
    expect(added).toHaveLength(1);
    expect(added[0].type).toBe("keydown");
    expect(added[0].opts).toEqual({ capture: true });
    const onKey = added[0].fn;
    onKey(chord());
    for (let i = 0; i < 40; i++) onKey(chord(true)); // held
    expect(kill).not.toHaveBeenCalled();
    onKey(chord());
    onKey(chord());
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith("keyboard Ctrl+Shift+X x3 (confirmed)", false);
  });
  it("its cleanup removes that same listener (no leaked E-stop listeners across remounts)", () => {
    const added = fakeWindow();
    useKillSwitchHotkey();
    expect(cleanups).toHaveLength(1);
    (cleanups[0] as () => void)();
    expect(removed).toEqual([{ type: "keydown", fn: added[0].fn, opts: { capture: true } }]);
  });
});
