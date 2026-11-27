import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * App-wide rule: the safety controls can't be hidden, made click-through or styled invisible.
 * Each one must carry its `data-safety` mark, and the stylesheet must force marked elements visible.
 */
const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

const MARKED: [file: string, id: string][] = [
  ["features/os/OsControls.tsx", "kill-switch"],
  ["features/hud/MobileHud.tsx", "kill-switch"],
  ["features/trading/KillButton.tsx", "trading-estop"],
  ["features/voice/VoiceHUD.tsx", "tony-stop"],
  ["features/voice/MicLockBadge.tsx", "tony-stop"],
  ["features/orchestrator/ConfirmCard.tsx", "confirm-card"],
  ["features/cloud/PushConfirmCard.tsx", "confirm-card"],
  ["features/cloud/ShareConfirmCard.tsx", "confirm-card"],
];

describe("safety controls carry their lock", () => {
  it.each(MARKED)("%s marks %s", (file, id) => {
    expect(src(file)).toContain(`safety("${id}")`);
  });

  it("the stylesheet forces marked controls visible and clickable", () => {
    const css = src("styles/index.css");
    const rule = css.slice(css.indexOf("[data-safety] {"));
    for (const decl of ["visibility: visible !important", "pointer-events: auto !important", "clip-path: none !important"]) expect(rule).toContain(decl);
  });
});
