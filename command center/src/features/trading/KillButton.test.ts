// @vitest-environment node
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { KillButton } from "./KillButton";
import { guardKillButtonKeydown } from "./kill-switch-core";

describe("KillButton (the red E-stop TradingDesk renders)", () => {
  it("its only handlers are killButtonProps': the click counter and the held-Enter guard", () => {
    const onPress = vi.fn();
    const el = KillButton({ pressed: 1, busy: false, onPress }) as ReactElement<Record<string, unknown>>;
    expect(el.type).toBe("button");
    expect(el.props.onKeyDown).toBe(guardKillButtonKeydown);
    expect(el.props.onClick).toBe(onPress);
    expect(Object.keys(el.props).filter((k) => /^on[A-Z]/.test(k)).sort()).toEqual(["onClick", "onKeyDown"]);
  });
  it("labels each stage and disables while a kill is in flight", () => {
    const html = (pressed: number, busy = false) => renderToStaticMarkup(createElement(KillButton, { pressed, busy, onPress: () => undefined }));
    expect(html(0)).toContain("KILL SWITCH · ARM");
    expect(html(1)).toContain("CONFIRM");
    expect(html(2)).toContain("EXECUTE KILL");
    expect(html(2)).toContain("animate-pulse");
    expect(html(0, true)).toContain("disabled");
  });
});
