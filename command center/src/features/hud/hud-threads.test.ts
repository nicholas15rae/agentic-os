import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { THREADS } from "@/features/voice/voice-store";

/**
 * Regression: the phone HUD listed six threads, without Tony's desktop conversation ("auto": the
 * Command view / VoiceHUD) or Ops, so most mirrored Nic↔Tony traffic was unreachable on the phone.
 * (Read from source: MobileHud.tsx is a browser-only component.)
 */
describe("the phone HUD shows every mirrored thread", () => {
  it("auto and ops are tabs, and every thread the desktop mirrors is listed", () => {
    const src = readFileSync(fileURLToPath(new URL("./MobileHud.tsx", import.meta.url)), "utf-8");
    const m = /export const HUD_THREADS: ThreadId\[\] = \[([^\]]*)\]/.exec(src);
    expect(m).not.toBeNull();
    const listed = [...m![1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
    for (const t of THREADS) expect(listed, t).toContain(t);
  });
});
